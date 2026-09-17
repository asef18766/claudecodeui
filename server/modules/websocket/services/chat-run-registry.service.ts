import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { projectTrackingService } from '@/modules/project-tracking/index.js';
import { describeBackgroundWork } from '@/shared/utils.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
  RunActivityState,
  RunBackgroundTask,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/** How a finished run ended, kept so the tracking board can be written once the session is finally idle. */
type ChatRunOutcome = {
  exitCode: number;
  aborted: boolean;
  terminalReason: string | null;
};

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 * - `activity`: what the session is actually doing, as the provider runtime
 *   reports it via `run_state`. Deliberately separate from `status`: a turn
 *   can be over (`status: completed`, so the next message may be sent) while
 *   the work it launched is still running (`activity: background`). Only
 *   `activity` is allowed to claim a session is idle.
 * - `outcome`: how the run ended. Recorded on `complete` and applied to the
 *   tracking board once `activity` reaches `idle`, so a session with
 *   background work is not filed as done the moment its turn returns.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  activity: RunActivityState;
  backgroundTasks: RunBackgroundTask[];
  outcome: ChatRunOutcome | null;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Reasons a provider reports for a run that stopped without finishing its
 * work. Anything outside this set (including no reason at all) is a clean end.
 */
const UNFINISHED_TERMINAL_REASONS = new Set([
  'aborted_streaming',
  'aborted_tools',
  'max_turns',
  'stop_hook_prevented',
  'hook_stopped',
  'blocking_limit',
  'rapid_refill_breaker',
  'prompt_too_long',
  'image_error',
  'model_error',
  'tool_deferred',
]);

/**
 * Maps how a run ended onto a tracking-board row.
 *
 * An interrupted run used to land on the board as `done`, because the abort
 * path reports exit code 0 for a *successful* interrupt. The provider's own
 * terminal reason is what separates "the user stopped it" from "it finished".
 */
function trackingOutcomeFor(outcome: ChatRunOutcome): { status: 'done' | 'error'; message: string | null } {
  if (outcome.aborted) {
    return { status: 'error', message: 'Interrupted before finishing' };
  }

  if (outcome.terminalReason && UNFINISHED_TERMINAL_REASONS.has(outcome.terminalReason)) {
    return { status: 'error', message: `Stopped early (${outcome.terminalReason})` };
  }

  if (outcome.exitCode !== 0) {
    return { status: 'error', message: `Run exited with code ${outcome.exitCode}` };
  }

  return { status: 'done', message: null };
}

/**
 * Applies a finished run's outcome to the tracking board and lets it be
 * evicted. Deferred while background work is still in flight, so a session
 * that launched a background shell or a subagent keeps its board row (and its
 * sidebar indicator) until that work actually reports back.
 */
function settleRun(run: ChatRun): void {
  if (!run.outcome || run.activity !== 'idle') {
    return;
  }

  const { status, message } = trackingOutcomeFor(run.outcome);
  projectTrackingService.updateStatus(run.appSessionId, status, message);
  evictRunLater(run.appSessionId);
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 * 5. Track the provider-reported `activity` so "is this session busy" stops
 *    being inferred from `complete`.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  // A run held open for background work can still be winding down when the
  // user sends the next message, and its trailing `run_state: idle` would
  // clear the indicator for the run that replaced it. State only counts while
  // this run is still the session's current one.
  if (message.kind === 'run_state' && runs.get(run.appSessionId) !== run) {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'run_state') {
    run.activity = message.state ?? 'idle';
    run.backgroundTasks = Array.isArray(message.backgroundTasks) ? message.backgroundTasks : [];
    if (run.activity === 'idle') {
      settleRun(run);
    }
  }

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    run.outcome = {
      exitCode: typeof message.exitCode === 'number' ? message.exitCode : 0,
      aborted: message.aborted === true,
      terminalReason: typeof message.terminalReason === 'string' ? message.terminalReason : null,
    };
    // The turn is over, but the session is only idle if the runtime says so.
    // Carrying the follow-on state on the `complete` itself (rather than as a
    // separate event right after it) keeps the two atomic: there is no window
    // where a session with background work looks finished.
    run.backgroundTasks = Array.isArray(message.backgroundTasks) ? message.backgroundTasks : [];
    run.activity = message.state === 'background' ? 'background' : 'idle';
    settleRun(run);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      activity: 'running',
      backgroundTasks: [],
      outcome: null,
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    projectTrackingService.updateStatus(input.appSessionId, 'running');
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  /**
   * Whether a turn is in flight — the gate for sends, replay and abort.
   *
   * Deliberately narrower than "busy": a session whose turn finished but whose
   * background work is still running answers `false` here (so the next message
   * can be sent) and `background` from `getActivity`.
   */
  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  /** What the session is doing, as its runtime last reported. */
  getActivity(appSessionId: string): RunActivityState {
    return runs.get(appSessionId)?.activity ?? 'idle';
  },

  /** Whether anything at all is outstanding — a turn, or work a turn launched. */
  isBusy(appSessionId: string): boolean {
    return (runs.get(appSessionId)?.activity ?? 'idle') !== 'idle';
  },

  /**
   * Every session that is still doing something, for the sidebar indicator and
   * the running-sessions poll.
   *
   * `phase` separates a live turn from leftover background work: the chat
   * composer must stay usable during the latter, while the sidebar and the
   * tracking board should still show the session as busy.
   */
  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    phase: 'turn' | 'background';
    statusText: string | null;
    canInterrupt: boolean;
    backgroundTasks: RunBackgroundTask[];
  }> {
    return Array.from(runs.values())
      .filter((run) => run.activity !== 'idle')
      .map((run) => {
        const isBackground = run.activity === 'background';
        return {
          sessionId: run.appSessionId,
          provider: run.provider,
          startedAt: run.startedAt,
          lastSeq: run.lastSeq,
          phase: isBackground ? ('background' as const) : ('turn' as const),
          statusText: isBackground ? describeBackgroundWork(run.backgroundTasks) : null,
          canInterrupt: !isBackground,
          backgroundTasks: run.backgroundTasks,
        };
      });
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
  },
};
