import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/** Result of one `sbx` invocation that ran to completion. */
type SbxCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** One entry of `sbx ls --json`. */
type SbxSandboxRecord = {
  name: string;
  agent: string;
  status: string;
  workspaces?: string[];
};

/** Built-in `sbx` agents this module can host a CloudCLI turn in. */
type SandboxAgent = 'claude' | 'codex';

/** One entry of `sbx template ls --json`. */
type SbxTemplateRecord = {
  id?: string;
  repository?: string;
  tag?: string;
  flavor?: string;
  created_at?: string;
  size?: number;
};

/** A template image already in the sandbox runtime's store, usable with `sbx create --template`. */
type SandboxTemplate = {
  /** Full image reference (`repository:tag`), as passed to `--template`. */
  reference: string;
  tag: string;
  repository: string;
  /** Short image id; matches the Docker daemon's id for images loaded from it. */
  id: string | null;
  flavor: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
};

/** One line of `docker images --format '{{json .}}'`. */
type DockerImageRecord = {
  ID?: string;
  Repository?: string;
  Tag?: string;
  Size?: string;
  CreatedAt?: string;
};

/**
 * A local Docker image the composer can offer. Choosing one that is not yet
 * a template makes the service export it (`docker save`) and load it into
 * the sandbox runtime (`sbx template load`).
 */
type SandboxDockerImage = {
  /** `repository:tag` as the Docker daemon names it. */
  reference: string;
  repository: string;
  tag: string;
  id: string;
  /** Human-readable size as reported by Docker (e.g. `953MB`). */
  size: string | null;
  createdAt: string | null;
  /** Template reference to pass to `sbx create --template` once imported; null until then. */
  templateReference: string | null;
  /**
   * Value of the image's `com.docker.sandboxes.flavor` label, e.g.
   * `claude-code-docker`. `sbx` needs it to apply an agent kit to the
   * sandbox; an image without it fails at creation with "failed to apply kit
   * to sandbox", so the composer greys those rows out. Null when absent.
   */
  agentFlavor: string | null;
};

/** Image label `sbx` reads to decide which agent kit an image can host. */
const SANDBOX_FLAVOR_LABEL = 'com.docker.sandboxes.flavor';

type WorkspaceSandboxServiceDependencies = {
  /**
   * Runs `sbx` with the given arguments until it exits, optionally feeding
   * `stdin`. Must resolve (never reject) so a missing binary is reported as a
   * failed result rather than an exception.
   */
  runSbx(argumentsList: string[], stdin?: string): Promise<SbxCommandResult>;
  /** Runs the `docker` CLI with the same contract as `runSbx`. */
  runDocker(argumentsList: string[]): Promise<SbxCommandResult>;
  /** Starts a long-lived `sbx` process whose stdio the caller owns (the agent CLI). */
  spawnSbx(argumentsList: string[]): ChildProcess;
  homeDirectory: string;
  /** Where generated launcher scripts are written (see `prepareCodexRun`). */
  scratchDirectory: string;
  /**
   * Where `docker save` tars land while an image is imported. Kept apart from
   * the scratch directory because these are image-sized (GBs) and `/tmp` is
   * often a small tmpfs.
   */
  exportDirectory: string;
  now(): number;
  logError(message: string): void;
};

/** What the UI needs to decide whether the sandbox toggle can be turned on. */
type SandboxStatus = {
  available: boolean;
  version: string | null;
  error: string | null;
};

type PrepareRunInput = {
  /** Host workspace path; mounted at the identical path inside the sandbox. */
  cwd: string;
  /** Provider-native session/thread id when the turn resumes an existing conversation. */
  providerSessionId: string | null;
  /**
   * Host paths of attachments the agent will read by path (chat uploads).
   * They are copied to the same path inside the sandbox before the turn.
   */
  attachmentPaths?: string[];
  /**
   * Template image for `sbx create --template`. Null means the agent's
   * built-in image; each distinct template gets its own sandbox per workspace.
   */
  template?: string | null;
};

/**
 * Everything the Claude runtime needs to run one turn inside a sandbox:
 * the SDK spawn hook plus the transcript sync that keeps the host's session
 * history in step with what the CLI wrote inside the sandbox.
 */
type SandboxedClaudeRun = {
  sandboxName: string;
  spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess;
  syncTranscriptToHost(providerSessionId: string): Promise<void>;
  /** Pulls a login the sandboxed CLI refreshed back to the host (see `syncClaudeCredentials`). */
  syncCredentialsToHost(): Promise<void>;
};

/**
 * Everything the Codex runtime needs to run one turn inside a sandbox. The
 * Codex SDK has no spawn hook, only a binary path override, so the sandbox
 * launch is a generated script that forwards to `sbx exec`.
 */
type SandboxedCodexRun = {
  sandboxName: string;
  /** Pass as `codexPathOverride`; behaves like the `codex` binary. */
  codexExecutablePath: string;
  /** Pulls the thread's rollout and any refreshed login back to the host. */
  syncToHost(threadId: string | null): Promise<void>;
};

/** `sbx version` is re-probed at most this often; the answer rarely changes. */
const STATUS_CACHE_TTL_MS = 30_000;

/**
 * Only SDK-facing switches cross into the sandbox. The rest of the host
 * environment (credentials, PATH, config dirs) must not: the sandbox has its
 * own credentials, and a host `CLAUDE_CONFIG_DIR` would point the sandboxed
 * CLI at a directory that does not exist there.
 */
const FORWARDED_ENV_PATTERN = /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK)/;

/** Same rule `sbx` applies to `--name`. */
const SANDBOX_NAME_PATTERN = /^[\w-]+$/;

/**
 * True when an image flavor can host this agent's kit. Flavors are named
 * after the agent with a suffix (`claude-code-docker`, `codex-docker`), so
 * the agent name appearing in the flavor is the signal — this keeps working
 * for images derived from a template with a different suffix.
 */
function flavorSupportsAgent(flavor: string | null, agent: SandboxAgent): boolean {
  return flavor !== null && flavor.toLowerCase().includes(agent);
}

/** Provider session ids are UUIDs; anything else must not reach a shell line. */
const PROVIDER_SESSION_ID_PATTERN = /^[\w-]+$/;

/** OCI image references: registry/repo[:tag][@digest]. Rejects anything shell-like. */
const TEMPLATE_REFERENCE_PATTERN = /^[\w.\-/]+(:[\w.\-]+)?(@sha256:[0-9a-f]{64})?$/;

/**
 * Claude Code names a project's transcript directory by replacing every
 * character outside `[a-zA-Z0-9]` in the absolute cwd with `-`. The sandbox
 * mounts the workspace at its host path, so the same name applies on both
 * sides; only the home directory differs.
 */
function encodeClaudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Stable, `sbx`-legal name for the sandbox that owns one workspace for one
 * agent. The template is part of the hash, so switching template yields a
 * separate sandbox instead of silently reusing one built from another image.
 */
function deriveSandboxName(agent: SandboxAgent, cwd: string, template: string | null): string {
  const baseName = path.basename(cwd).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const digest = crypto.createHash('sha1').update(template ? `${cwd}\n${template}` : cwd).digest('hex').slice(0, 8);
  return `cloudcli-${agent}-${baseName}-${digest}`.slice(0, 63);
}

/** Single-quotes a value for a POSIX shell line run inside the sandbox. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The SDK hands the spawn hook the full local launch line. For a JavaScript
 * entrypoint that is `node [nodeFlags] /path/to/cli.js --output-format ...`;
 * for a native binary it is just the CLI flags. Inside the sandbox the CLI is
 * invoked as `claude`, so only the flags after the entrypoint are kept.
 */
function extractClaudeCliArguments(command: string, argumentsList: string[]): string[] {
  const launcher = path.basename(command).toLowerCase();
  if (!/^(node|bun|deno)(\.exe)?$/.test(launcher)) {
    return argumentsList;
  }

  const entrypointIndex = argumentsList.findIndex((argument) => /\.(c|m)?js$/i.test(argument));
  return entrypointIndex === -1 ? argumentsList : argumentsList.slice(entrypointIndex + 1);
}

function buildForwardedEnvArguments(env: SpawnOptions['env']): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && FORWARDED_ENV_PATTERN.test(key))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function parseSbxVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function describeFailure(result: SbxCommandResult): string {
  return (result.stderr || result.stdout).trim() || `sbx exited with code ${result.exitCode}`;
}

/**
 * Freshness of a Claude `~/.claude/.credentials.json` (OAuth subscription
 * login): the access token's `expiresAt`, which moves forward on every
 * refresh. -Infinity when unreadable — the newer copy wins a sync.
 */
function readClaudeCredentialTimestamp(content: string | null): number {
  if (!content) {
    return Number.NEGATIVE_INFINITY;
  }
  try {
    const parsed = JSON.parse(content) as { claudeAiOauth?: { expiresAt?: number } };
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/** `last_refresh` of a Codex `auth.json`, or -Infinity when unreadable — the newer copy wins a sync. */
function readCodexAuthTimestamp(content: string | null): number {
  if (!content) {
    return Number.NEGATIVE_INFINITY;
  }
  try {
    const parsed = JSON.parse(content) as { last_refresh?: string };
    const timestamp = parsed.last_refresh ? Date.parse(parsed.last_refresh) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/** Finds `rollout-*-<threadId>.jsonl` under a Codex sessions tree (`<year>/<month>/<day>/...`). */
async function findCodexRolloutOnHost(sessionsRoot: string, threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        return entryPath;
      }
    }
  }
  return null;
}

/**
 * Creates the workspace sandbox service. Subprocess, clock, home and logging
 * access are injected so tests can drive it without a Docker Sandboxes install.
 */
export function createWorkspaceSandboxService(dependencies: WorkspaceSandboxServiceDependencies) {
  let cachedStatus: { status: SandboxStatus; probedAt: number } | null = null;

  const assertSafeProviderSessionId = (providerSessionId: string): void => {
    if (!PROVIDER_SESSION_ID_PATTERN.test(providerSessionId)) {
      throw new Error(`Refusing to sync transcript for unsafe session id: ${providerSessionId}`);
    }
  };

  async function getStatus(): Promise<SandboxStatus> {
    const now = dependencies.now();
    if (cachedStatus && now - cachedStatus.probedAt < STATUS_CACHE_TTL_MS) {
      return cachedStatus.status;
    }

    const result = await dependencies.runSbx(['version']);
    const status: SandboxStatus = result.exitCode === 0
      ? { available: true, version: parseSbxVersion(result.stdout), error: null }
      : {
        available: false,
        version: null,
        error: result.stderr.trim() || 'Docker Sandboxes CLI (sbx) is not installed or not working.',
      };
    cachedStatus = { status, probedAt: now };
    return status;
  }

  async function listSandboxes(): Promise<SbxSandboxRecord[]> {
    const result = await dependencies.runSbx(['ls', '--json']);
    if (result.exitCode !== 0) {
      throw new Error(`Could not list Docker sandboxes: ${describeFailure(result)}`);
    }
    try {
      const parsed = JSON.parse(result.stdout) as { sandboxes?: SbxSandboxRecord[] } | SbxSandboxRecord[];
      return Array.isArray(parsed) ? parsed : parsed.sandboxes ?? [];
    } catch {
      throw new Error('Could not parse `sbx ls --json` output.');
    }
  }

  /** Template images available locally, newest first. */
  async function listTemplates(): Promise<SandboxTemplate[]> {
    const result = await dependencies.runSbx(['template', 'ls', '--json']);
    if (result.exitCode !== 0) {
      throw new Error(`Could not list sandbox templates: ${describeFailure(result)}`);
    }
    let records: SbxTemplateRecord[];
    try {
      const parsed = JSON.parse(result.stdout) as { images?: SbxTemplateRecord[] } | SbxTemplateRecord[];
      records = Array.isArray(parsed) ? parsed : parsed.images ?? [];
    } catch {
      throw new Error('Could not parse `sbx template ls --json` output.');
    }
    return records
      .filter((record) => record.repository && record.tag)
      .map((record) => ({
        reference: `${record.repository}:${record.tag}`,
        tag: record.tag as string,
        repository: record.repository as string,
        id: record.id ?? null,
        flavor: record.flavor ?? null,
        sizeBytes: typeof record.size === 'number' ? record.size : null,
        createdAt: record.created_at ?? null,
      }))
      .filter((template) => TEMPLATE_REFERENCE_PATTERN.test(template.reference))
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  }

  /**
   * Local Docker images, newest first, each annotated with the sandbox
   * template it already maps to (matched by image id, which `sbx template
   * load` preserves) so the composer can tell "ready" from "needs import".
   */
  async function listDockerImages(): Promise<SandboxDockerImage[]> {
    const result = await dependencies.runDocker(['images', '--format', '{{json .}}']);
    if (result.exitCode !== 0) {
      throw new Error(`Could not list Docker images: ${describeFailure(result)}`);
    }
    const templates = await listTemplates().catch(() => [] as SandboxTemplate[]);
    const templateById = new Map(templates.filter((template) => template.id).map((template) => [template.id as string, template]));

    const images: SandboxDockerImage[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let record: DockerImageRecord;
      try {
        record = JSON.parse(line) as DockerImageRecord;
      } catch {
        continue;
      }
      // Dangling layers have no name and cannot be referenced anyway.
      if (!record.ID || !record.Repository || !record.Tag || record.Repository === '<none>' || record.Tag === '<none>') {
        continue;
      }
      const reference = `${record.Repository}:${record.Tag}`;
      if (!TEMPLATE_REFERENCE_PATTERN.test(reference)) {
        continue;
      }
      images.push({
        reference,
        repository: record.Repository,
        tag: record.Tag,
        id: record.ID,
        size: record.Size ?? null,
        createdAt: record.CreatedAt ?? null,
        templateReference: templateById.get(record.ID)?.reference ?? null,
        agentFlavor: null,
      });
    }

    // One inspect for every image rather than one per image: the flavor label
    // is the only thing that tells a usable agent base from an unrelated
    // image, and the composer needs it for the whole list at once.
    //
    // `{{json .Config}}` rather than indexing `.Config.Labels` directly: an
    // image with no labels at all has no `Labels` key, which makes the Go
    // template abort for *every* image in the same call.
    if (images.length > 0) {
      const inspected = await dependencies.runDocker([
        'image', 'inspect', ...images.map((image) => image.reference),
        '--format', '{{.Id}}\t{{json .Config}}',
      ]);
      const flavorByFullId = new Map<string, string>();
      // Parsed regardless of exit code: one unreadable image must not cost
      // the flavors of the others.
      for (const line of inspected.stdout.split('\n')) {
        const separator = line.indexOf('\t');
        if (separator === -1) {
          continue;
        }
        const fullId = line.slice(0, separator).trim();
        try {
          const config = JSON.parse(line.slice(separator + 1)) as { Labels?: Record<string, string> | null };
          const flavor = config.Labels?.[SANDBOX_FLAVOR_LABEL];
          if (fullId && flavor) {
            flavorByFullId.set(fullId, flavor);
          }
        } catch {
          continue;
        }
      }
      for (const image of images) {
        // `docker images` reports the short id; inspect reports `sha256:<full>`.
        for (const [fullId, flavor] of flavorByFullId) {
          if (fullId.replace(/^sha256:/, '').startsWith(image.id)) {
            image.agentFlavor = flavor;
            break;
          }
        }
      }
    }

    return images.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  }

  // One export per image at a time: a double click must not `docker save` twice.
  const importsInFlight = new Map<string, Promise<SandboxTemplate>>();

  /**
   * Makes a local Docker image usable as a sandbox template. The sandbox
   * runtime keeps its own image store, so the image is exported with
   * `docker save` and loaded with `sbx template load`; an image whose id is
   * already in the store is returned as-is without re-exporting.
   */
  function importDockerImageAsTemplate(reference: string): Promise<SandboxTemplate> {
    if (!TEMPLATE_REFERENCE_PATTERN.test(reference)) {
      return Promise.reject(new Error(`Invalid Docker image reference: ${reference}`));
    }
    const inFlight = importsInFlight.get(reference);
    if (inFlight) {
      return inFlight;
    }

    const run = (async () => {
      const image = (await listDockerImages()).find((candidate) => candidate.reference === reference);
      if (!image) {
        throw new Error(`Docker image not found locally: ${reference}`);
      }
      const existing = (await listTemplates()).find((template) => template.id === image.id);
      if (existing) {
        return existing;
      }

      await fs.mkdir(dependencies.exportDirectory, { recursive: true });
      const tarPath = path.join(dependencies.exportDirectory, `import-${image.id}.tar`);
      try {
        const saved = await dependencies.runDocker(['save', reference, '-o', tarPath]);
        if (saved.exitCode !== 0) {
          throw new Error(`Could not export Docker image ${reference}: ${describeFailure(saved)}`);
        }
        const loaded = await dependencies.runSbx(['template', 'load', tarPath]);
        if (loaded.exitCode !== 0) {
          throw new Error(`Could not load ${reference} as a sandbox template: ${describeFailure(loaded)}`);
        }
      } finally {
        await fs.rm(tarPath, { force: true });
      }

      // `sbx` normalises the name (`redis:7` becomes `docker.io/library/redis:7`),
      // so the loaded template is found by id rather than by the name given.
      const template = (await listTemplates()).find((candidate) => candidate.id === image.id);
      if (!template) {
        throw new Error(`Loaded ${reference} but it did not appear in the sandbox template store.`);
      }
      return template;
    })();

    importsInFlight.set(reference, run);
    run.finally(() => importsInFlight.delete(reference)).catch(() => undefined);
    return run;
  }

  /**
   * Finds or creates the sandbox for this agent on this workspace. Without a
   * template any existing sandbox for the agent on the workspace is reused
   * (including ones the user created with `sbx` directly); with a template
   * only the sandbox derived from that exact template is, so images never get
   * mixed up. The sandbox is created detached; `sbx exec` starts it on first use.
   */
  async function ensureWorkspaceSandbox(agent: SandboxAgent, cwd: string, template: string | null): Promise<string> {
    if (template !== null && !TEMPLATE_REFERENCE_PATTERN.test(template)) {
      throw new Error(`Invalid sandbox template reference: ${template}`);
    }

    if (template !== null) {
      // `sbx create` fails with a bare "failed to apply kit to sandbox" when
      // the image cannot host the agent, which says nothing about the cause.
      // The flavor label is the same thing sbx checks, so report it here.
      const chosen = (await listTemplates()).find((candidate) => candidate.reference === template);
      if (!chosen) {
        throw new Error(`Sandbox template "${template}" is no longer in the sandbox image store. Pick the Docker image again to re-import it.`);
      }
      if (!flavorSupportsAgent(chosen.flavor, agent)) {
        throw new Error(
          `The image "${template}" cannot run ${agent}: it has no "${SANDBOX_FLAVOR_LABEL}" label for ${agent}. `
          + `Build the image FROM docker/sandbox-templates:${agent === 'claude' ? 'claude-code' : 'codex'}, or snapshot a working sandbox with \`sbx template save\`.`,
        );
      }
    }

    const sandboxName = deriveSandboxName(agent, cwd, template);
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      throw new Error(`Derived sandbox name is invalid: ${sandboxName}`);
    }

    const sandboxes = await listSandboxes();
    const candidates = template === null
      ? sandboxes.filter((sandbox) => sandbox.agent === agent && sandbox.workspaces?.[0] === cwd)
      : sandboxes.filter((sandbox) => sandbox.name === sandboxName && sandbox.agent === agent);
    const preferred = candidates.find((sandbox) => sandbox.status === 'running') ?? candidates[0];
    if (preferred) {
      return preferred.name;
    }

    const result = await dependencies.runSbx([
      'create',
      ...(template === null ? [] : ['--template', template]),
      '--name',
      sandboxName,
      agent,
      cwd,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Could not create Docker sandbox for ${cwd}: ${describeFailure(result)}`);
    }
    return sandboxName;
  }

  /**
   * `sbx exec` starts a stopped sandbox on demand; doing that up front keeps
   * the start-up out of the CLI's stdio stream and surfaces failures before a
   * turn is under way.
   */
  async function warmUpSandbox(sandboxName: string): Promise<void> {
    const warmUp = await dependencies.runSbx(['exec', sandboxName, 'true']);
    if (warmUp.exitCode !== 0) {
      throw new Error(`Could not start Docker sandbox ${sandboxName}: ${describeFailure(warmUp)}`);
    }
  }

  // ----- file transfer primitives; `shellPath` is an already-quoted shell word
  // (it may reference $HOME, which only resolves inside the sandbox).

  async function readSandboxFile(sandboxName: string, shellPath: string): Promise<string | null> {
    const result = await dependencies.runSbx(['exec', sandboxName, 'sh', '-c', `cat ${shellPath}`]);
    return result.exitCode === 0 ? result.stdout : null;
  }

  async function sandboxFileExists(sandboxName: string, shellPath: string): Promise<boolean> {
    const probe = await dependencies.runSbx(['exec', sandboxName, 'sh', '-c', `test -f ${shellPath}`]);
    return probe.exitCode === 0;
  }

  async function writeSandboxFile(
    sandboxName: string,
    shellPath: string,
    content: string,
    mode: string | null = null,
  ): Promise<void> {
    const chmod = mode ? ` && chmod ${mode} ${shellPath}` : '';
    const copy = await dependencies.runSbx(
      ['exec', '-i', sandboxName, 'sh', '-c', `mkdir -p "$(dirname ${shellPath})" && cat > ${shellPath}${chmod}`],
      content,
    );
    if (copy.exitCode !== 0) {
      throw new Error(`Could not write ${shellPath} into sandbox ${sandboxName}: ${describeFailure(copy)}`);
    }
  }

  async function writeHostFile(destination: string, content: string, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Write-then-rename so the sessions watcher never sees a half-written file.
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    await fs.rename(temporary, destination);
  }

  /**
   * Copies chat uploads to the same absolute path inside the sandbox. The
   * agent receives those paths in its prompt and reads them itself, which
   * only works when the file exists where the prompt says it does.
   */
  async function pushAttachmentsToSandbox(sandboxName: string, attachmentPaths: string[]): Promise<void> {
    for (const attachmentPath of attachmentPaths) {
      if (!path.isAbsolute(attachmentPath)) {
        continue;
      }
      let content: Buffer;
      try {
        content = await fs.readFile(attachmentPath);
      } catch {
        continue;
      }
      // Binary-safe: base64 across the pipe, decoded on the far side.
      const shellPath = shellQuote(attachmentPath);
      const copy = await dependencies.runSbx(
        ['exec', '-i', sandboxName, 'sh', '-c', `mkdir -p "$(dirname ${shellPath})" && base64 -d > ${shellPath}`],
        content.toString('base64'),
      );
      if (copy.exitCode !== 0) {
        throw new Error(`Could not copy attachment into sandbox ${sandboxName}: ${describeFailure(copy)}`);
      }
    }
  }

  // ----- Claude transcripts: fixed path on both sides.

  const claudeHostTranscriptPath = (cwd: string, providerSessionId: string): string => path.join(
    dependencies.homeDirectory,
    '.claude',
    'projects',
    encodeClaudeProjectDirectory(cwd),
    `${providerSessionId}.jsonl`,
  );

  const claudeSandboxTranscriptPath = (cwd: string, providerSessionId: string): string =>
    `"$HOME/.claude/projects/${encodeClaudeProjectDirectory(cwd)}/${providerSessionId}.jsonl"`;

  /**
   * Copies the host transcript into the sandbox when the sandbox does not have
   * it, so `--resume` works for conversations that started outside the
   * sandbox (or after the sandbox was recreated).
   */
  async function pushClaudeTranscript(sandboxName: string, cwd: string, providerSessionId: string): Promise<void> {
    assertSafeProviderSessionId(providerSessionId);
    let content: string;
    try {
      content = await fs.readFile(claudeHostTranscriptPath(cwd, providerSessionId), 'utf8');
    } catch {
      return;
    }
    const target = claudeSandboxTranscriptPath(cwd, providerSessionId);
    if (await sandboxFileExists(sandboxName, target)) {
      return;
    }
    await writeSandboxFile(sandboxName, target, content);
  }

  /**
   * Copies the transcript the sandboxed CLI wrote back to the host's
   * `~/.claude/projects`, which is where session history is read from and
   * where the sessions watcher indexes new conversations.
   */
  async function pullClaudeTranscript(sandboxName: string, cwd: string, providerSessionId: string): Promise<void> {
    assertSafeProviderSessionId(providerSessionId);
    const content = await readSandboxFile(sandboxName, claudeSandboxTranscriptPath(cwd, providerSessionId));
    if (content === null) {
      throw new Error(`Could not read session transcript from sandbox ${sandboxName}`);
    }
    await writeHostFile(claudeHostTranscriptPath(cwd, providerSessionId), content);
  }

  function spawnSandboxedClaude(sandboxName: string, cwd: string, options: SpawnOptions): SpawnedProcess {
    const child = dependencies.spawnSbx([
      'exec',
      '-i',
      '-w',
      cwd,
      ...buildForwardedEnvArguments(options.env),
      sandboxName,
      'claude',
      ...extractClaudeCliArguments(options.command, options.args),
    ]);

    // The SDK only consumes stdout; an unread stderr pipe would eventually
    // block the CLI, so drain it into the server log instead.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        dependencies.logError(`[Sandbox ${sandboxName}] ${text}`);
      }
    });

    // Fires only after the SDK's graceful stdin-EOF window has passed.
    options.signal.addEventListener('abort', () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }, { once: true });

    return child as unknown as SpawnedProcess;
  }

  // ----- Subscription logins: the sandbox has no `sbx secret` for a
  // subscription, so the host's credential file is what lets the sandboxed
  // CLI authenticate. Either side may refresh the tokens, so the newer copy
  // always overwrites the older one, before and after a turn; a host without
  // a login leaves the sandbox's own login alone.

  async function syncCredentialFile(
    sandboxName: string,
    hostPath: string,
    sandboxShellPath: string,
    readTimestamp: (content: string | null) => number,
  ): Promise<void> {
    let hostContent: string | null = null;
    try {
      hostContent = await fs.readFile(hostPath, 'utf8');
    } catch {
      hostContent = null;
    }
    const sandboxContent = await readSandboxFile(sandboxName, sandboxShellPath);

    const hostTimestamp = readTimestamp(hostContent);
    const sandboxTimestamp = readTimestamp(sandboxContent);
    if (hostContent !== null && hostTimestamp > sandboxTimestamp) {
      await writeSandboxFile(sandboxName, sandboxShellPath, hostContent, '600');
    } else if (sandboxContent !== null && sandboxTimestamp > hostTimestamp) {
      await writeHostFile(hostPath, sandboxContent, 0o600);
    }
  }

  /** Claude Code OAuth login (`~/.claude/.credentials.json`), compared by token `expiresAt`. */
  const syncClaudeCredentials = (sandboxName: string) => syncCredentialFile(
    sandboxName,
    path.join(dependencies.homeDirectory, '.claude', '.credentials.json'),
    '"$HOME/.claude/.credentials.json"',
    readClaudeCredentialTimestamp,
  );

  // ----- Codex: rollouts live in a date tree, login lives in auth.json.

  const codexHostHome = path.join(dependencies.homeDirectory, '.codex');

  /** Codex ChatGPT login (`~/.codex/auth.json`), compared by `last_refresh`. */
  const syncCodexAuth = (sandboxName: string) => syncCredentialFile(
    sandboxName,
    path.join(codexHostHome, 'auth.json'),
    '"$HOME/.codex/auth.json"',
    readCodexAuthTimestamp,
  );

  /** Locates a thread's rollout inside the sandbox; returns its path relative to `~/.codex`. */
  async function findCodexRolloutInSandbox(sandboxName: string, threadId: string): Promise<string | null> {
    const result = await dependencies.runSbx([
      'exec', sandboxName, 'sh', '-c',
      `cd "$HOME/.codex" 2>/dev/null && find sessions -type f -name ${shellQuote(`rollout-*-${threadId}.jsonl`)} | head -n 1`,
    ]);
    const relativePath = result.stdout.trim();
    return result.exitCode === 0 && relativePath ? relativePath : null;
  }

  async function pushCodexRollout(sandboxName: string, threadId: string): Promise<void> {
    assertSafeProviderSessionId(threadId);
    const hostPath = await findCodexRolloutOnHost(path.join(codexHostHome, 'sessions'), threadId);
    if (!hostPath) {
      return;
    }
    if (await findCodexRolloutInSandbox(sandboxName, threadId)) {
      return;
    }
    const relativePath = path.relative(codexHostHome, hostPath).split(path.sep).join('/');
    const content = await fs.readFile(hostPath, 'utf8');
    await writeSandboxFile(sandboxName, `"$HOME/.codex/${relativePath}"`, content);
  }

  async function pullCodexRollout(sandboxName: string, threadId: string): Promise<void> {
    assertSafeProviderSessionId(threadId);
    const relativePath = await findCodexRolloutInSandbox(sandboxName, threadId);
    if (!relativePath) {
      throw new Error(`Rollout for thread ${threadId} was not found in sandbox ${sandboxName}`);
    }
    const content = await readSandboxFile(sandboxName, `"$HOME/.codex/${relativePath}"`);
    if (content === null) {
      throw new Error(`Could not read rollout for thread ${threadId} from sandbox ${sandboxName}`);
    }
    await writeHostFile(path.join(codexHostHome, ...relativePath.split('/')), content);
  }

  /**
   * Writes the script the Codex SDK launches instead of the `codex` binary.
   * It forwards every invocation to the CLI inside the sandbox, keeping stdin
   * (the prompt) and stdout (the JSON event stream) attached. Only the SDK's
   * originator marker crosses over; the rest of the host env stays out.
   */
  async function writeCodexLauncher(sandboxName: string, cwd: string): Promise<string> {
    const launcherPath = path.join(dependencies.scratchDirectory, `codex-${sandboxName}.sh`);
    const script = [
      '#!/bin/sh',
      `# Generated by CloudCLI: runs the Codex CLI inside Docker sandbox ${sandboxName}.`,
      `exec sbx exec -i -w ${shellQuote(cwd)} \${CODEX_INTERNAL_ORIGINATOR_OVERRIDE:+-e "CODEX_INTERNAL_ORIGINATOR_OVERRIDE=$CODEX_INTERNAL_ORIGINATOR_OVERRIDE"} ${shellQuote(sandboxName)} codex "$@"`,
      '',
    ].join('\n');
    await fs.mkdir(dependencies.scratchDirectory, { recursive: true });
    await fs.writeFile(launcherPath, script, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(launcherPath, 0o755);
    return launcherPath;
  }

  async function requireAvailable(): Promise<void> {
    const status = await getStatus();
    if (!status.available) {
      throw new Error(`Docker sandbox unavailable: ${status.error}`);
    }
  }

  return {
    getStatus,
    listTemplates,
    listDockerImages,
    importDockerImageAsTemplate,

    /**
     * Prepares one Claude turn to run inside the workspace's sandbox: checks
     * `sbx` is usable, finds or creates the sandbox, starts it, syncs the
     * subscription login, seeds the transcript being resumed and any
     * attachments, and returns the SDK spawn hook.
     */
    async prepareClaudeRun(input: PrepareRunInput): Promise<SandboxedClaudeRun> {
      await requireAvailable();
      const cwd = path.resolve(input.cwd);
      const sandboxName = await ensureWorkspaceSandbox('claude', cwd, input.template ?? null);
      await warmUpSandbox(sandboxName);
      await syncClaudeCredentials(sandboxName);
      if (input.providerSessionId) {
        await pushClaudeTranscript(sandboxName, cwd, input.providerSessionId);
      }
      await pushAttachmentsToSandbox(sandboxName, input.attachmentPaths ?? []);

      return {
        sandboxName,
        spawnClaudeCodeProcess: (options) => spawnSandboxedClaude(sandboxName, cwd, options),
        syncTranscriptToHost: (providerSessionId) => pullClaudeTranscript(sandboxName, cwd, providerSessionId),
        syncCredentialsToHost: () => syncClaudeCredentials(sandboxName),
      };
    },

    /**
     * Prepares one Codex turn to run inside the workspace's sandbox: same
     * lifecycle as Claude, plus the login sync (ChatGPT subscription tokens
     * from `~/.codex/auth.json`) and a generated launcher for the SDK.
     */
    async prepareCodexRun(input: PrepareRunInput): Promise<SandboxedCodexRun> {
      await requireAvailable();
      const cwd = path.resolve(input.cwd);
      const sandboxName = await ensureWorkspaceSandbox('codex', cwd, input.template ?? null);
      await warmUpSandbox(sandboxName);
      await syncCodexAuth(sandboxName);
      if (input.providerSessionId) {
        await pushCodexRollout(sandboxName, input.providerSessionId);
      }
      await pushAttachmentsToSandbox(sandboxName, input.attachmentPaths ?? []);
      const codexExecutablePath = await writeCodexLauncher(sandboxName, cwd);

      return {
        sandboxName,
        codexExecutablePath,
        async syncToHost(threadId) {
          if (threadId) {
            await pullCodexRollout(sandboxName, threadId);
          }
          await syncCodexAuth(sandboxName);
        },
      };
    },
  };
}

function runCliCommand(command: string, argumentsList: string[], stdin?: string): Promise<SbxCommandResult> {
  return new Promise((resolve) => {
    const child = spawnChildProcess(command, argumentsList, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      resolve({ exitCode: null, stdout, stderr: stderr || error.message });
    });
    child.once('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

// workspaceSandboxService: used by the Claude and Codex runtime providers to
// run a turn inside the workspace's Docker sandbox, and by the sandbox routes
// for status.
export const workspaceSandboxService = createWorkspaceSandboxService({
  runSbx: (argumentsList, stdin) => runCliCommand('sbx', argumentsList, stdin),
  runDocker: (argumentsList) => runCliCommand('docker', argumentsList),
  spawnSbx: (argumentsList) => spawnChildProcess('sbx', argumentsList, { stdio: ['pipe', 'pipe', 'pipe'] }),
  homeDirectory: os.homedir(),
  scratchDirectory: path.join(os.tmpdir(), 'cloudcli-sandbox'),
  exportDirectory: path.join(os.homedir(), '.cloudcli', 'sandbox-imports'),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});
