import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { MarkSessionProcessing, PendingPermissionRequest, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Claude reports a turn's `result` while its process is still held open for the
 * work that turn launched (background shells, subagents, monitors, scheduled
 * wake-ups). Treating that as "done" is what made a session read as finished
 * while it was still producing.
 *
 * These tests pin the handoff: the terminal `complete` carries the follow-on
 * state, and only an explicit idle clears the session.
 */

vi.mock('@/modules/chat/utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: () => {},
}));
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playChatCompletionSound: () => {},
  playNotificationSound: () => {},
}));

type MarkCall = { sessionId?: string | null; activity?: Parameters<MarkSessionProcessing>[1] };

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const processingCalls: MarkCall[] = [];
  const idleCalls: Array<string | null | undefined> = [];
  let pending: PendingPermissionRequest[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: (next) => {
      pending = typeof next === 'function' ? next(pending) : next;
    },
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId, activity) => processingCalls.push({ sessionId, activity }),
    onSessionIdle: (sessionId) => idleCalls.push(sessionId),
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: () => {},
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  return {
    dispatch: (event: ServerEvent) => listener?.(event),
    processingCalls,
    idleCalls,
  };
};

test('a turn that leaves background work running keeps the session marked busy', () => {
  const { dispatch, processingCalls, idleCalls } = renderHandlers();

  dispatch({
    kind: 'complete',
    sessionId: 'viewed-session',
    exitCode: 0,
    success: true,
    state: 'background',
    text: 'Background: npm test',
    backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running', description: 'npm test' }],
    seq: 1,
  } as unknown as ServerEvent);

  // The turn is over, but the session is not idle — it moves to its background
  // phase, which keeps the indicator and the sidebar honest while leaving the
  // composer free to send the next message.
  assert.deepEqual(idleCalls, []);
  assert.deepEqual(processingCalls, [{
    sessionId: 'viewed-session',
    activity: { phase: 'background', statusText: 'Background: npm test', canInterrupt: false },
  }]);
});

test('an explicit idle run_state is what finally clears the session', () => {
  const { dispatch, idleCalls } = renderHandlers();

  dispatch({
    kind: 'complete',
    sessionId: 'viewed-session',
    exitCode: 0,
    success: true,
    state: 'background',
    backgroundTasks: [{ id: 'task-1', type: 'monitor', status: 'running', description: 'watching CI' }],
    seq: 1,
  } as unknown as ServerEvent);
  assert.deepEqual(idleCalls, []);

  dispatch({ kind: 'run_state', sessionId: 'viewed-session', state: 'idle', seq: 2 } as unknown as ServerEvent);
  assert.deepEqual(idleCalls, ['viewed-session']);
});

test('a turn with nothing outstanding still ends the session immediately', () => {
  const { dispatch, processingCalls, idleCalls } = renderHandlers();

  dispatch({
    kind: 'complete',
    sessionId: 'viewed-session',
    exitCode: 0,
    success: true,
    state: 'idle',
    seq: 1,
  } as unknown as ServerEvent);

  assert.deepEqual(idleCalls, ['viewed-session']);
  assert.deepEqual(processingCalls, []);
});

test('the subscribe ack restores the background phase after a refresh', () => {
  const { dispatch, processingCalls, idleCalls } = renderHandlers();

  dispatch({
    kind: 'chat_subscribed',
    sessionId: 'viewed-session',
    isProcessing: false,
    activity: 'background',
    backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running', description: 'npm test' }],
    pendingPermissions: [],
  } as unknown as ServerEvent);

  assert.deepEqual(idleCalls, []);
  assert.deepEqual(processingCalls, [{
    sessionId: 'viewed-session',
    activity: { phase: 'background', statusText: 'Background: npm test', canInterrupt: false },
  }]);
});
