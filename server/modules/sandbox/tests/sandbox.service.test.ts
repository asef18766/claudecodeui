import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';

import { createWorkspaceSandboxService } from '../sandbox.service.js';

type RecordedCall = { argumentsList: string[]; stdin?: string };

type FakeSbxResponse = { exitCode?: number | null; stdout?: string; stderr?: string };

/**
 * Builds a service whose `sbx` calls are answered by `respond` and recorded
 * for assertions. Spawned processes are inert emitters with piped streams.
 */
function createHarness(
  respond: (argumentsList: string[], stdin?: string) => FakeSbxResponse,
  homeDirectory = '/home/host',
  scratchDirectory = '/tmp/cloudcli-sandbox-test-scratch',
  respondDocker: (argumentsList: string[]) => FakeSbxResponse = () => ({ exitCode: 1, stderr: 'docker: not stubbed' }),
) {
  const calls: RecordedCall[] = [];
  const dockerCalls: string[][] = [];
  const spawned: string[][] = [];
  const errors: string[] = [];
  let now = 1_000;

  const service = createWorkspaceSandboxService({
    homeDirectory,
    scratchDirectory,
    exportDirectory: scratchDirectory,
    now: () => now,
    logError: (message) => errors.push(message),
    runSbx: async (argumentsList, stdin) => {
      calls.push({ argumentsList, stdin });
      const response = respond(argumentsList, stdin);
      return {
        // `null` is a real answer (spawn failure), so only an omitted key defaults to success.
        exitCode: 'exitCode' in response ? response.exitCode ?? null : 0,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      };
    },
    runDocker: async (argumentsList) => {
      dockerCalls.push(argumentsList);
      const response = respondDocker(argumentsList);
      return {
        exitCode: 'exitCode' in response ? response.exitCode ?? null : 0,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      };
    },
    spawnSbx: (argumentsList) => {
      spawned.push(argumentsList);
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        exitCode: number | null;
        kill(): boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      return child as unknown as ChildProcess;
    },
  });

  return {
    service,
    calls,
    dockerCalls,
    spawned,
    errors,
    advanceClock: (milliseconds: number) => { now += milliseconds; },
  };
}

const sandboxList = (sandboxes: Array<{ name: string; agent?: string; status?: string; workspaces?: string[] }>) =>
  JSON.stringify({
    sandboxes: sandboxes.map((sandbox) => ({
      agent: 'claude',
      status: 'stopped',
      ...sandbox,
    })),
  });

test('status reports the sbx version and caches the probe', async () => {
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'version'
      ? { stdout: 'sbx version: v0.42.1 cc6e400a' }
      : {}
  ));

  assert.deepEqual(await harness.service.getStatus(), { available: true, version: '0.42.1', error: null });
  await harness.service.getStatus();
  assert.equal(harness.calls.filter((call) => call.argumentsList[0] === 'version').length, 1);

  harness.advanceClock(60_000);
  await harness.service.getStatus();
  assert.equal(harness.calls.filter((call) => call.argumentsList[0] === 'version').length, 2);
});

test('status reports an unavailable CLI without throwing', async () => {
  const harness = createHarness(() => ({ exitCode: null, stderr: 'spawn sbx ENOENT' }));

  const status = await harness.service.getStatus();

  assert.equal(status.available, false);
  assert.equal(status.version, null);
  assert.match(status.error ?? '', /ENOENT/);
});

test('prepareClaudeRun refuses to run when sbx is unavailable', async () => {
  const harness = createHarness(() => ({ exitCode: 1, stderr: 'not found' }));

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null }),
    /Docker sandbox unavailable/,
  );
  assert.equal(harness.calls.some((call) => call.argumentsList[0] === 'create'), false);
});

test('prepareClaudeRun reuses a sandbox already mounted on the workspace and warms it up', async () => {
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'ls') {
      return {
        stdout: sandboxList([
          { name: 'other', workspaces: ['/work/other'] },
          { name: 'codex-on-same-workspace', agent: 'codex', workspaces: ['/work/app'] },
          { name: 'claude-test', workspaces: ['/work/app'] },
        ]),
      };
    }
    return {};
  });

  const run = await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });

  assert.equal(run.sandboxName, 'claude-test');
  assert.equal(harness.calls.some((call) => call.argumentsList[0] === 'create'), false);
  assert.deepEqual(
    harness.calls.find((call) => call.argumentsList[0] === 'exec')?.argumentsList,
    ['exec', 'claude-test', 'true'],
  );
});

test('prepareClaudeRun creates a deterministic sandbox when none owns the workspace', async () => {
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'ls' ? { stdout: sandboxList([]) } : {}
  ));

  const first = await harness.service.prepareClaudeRun({ cwd: '/work/My App', providerSessionId: null });
  const create = harness.calls.find((call) => call.argumentsList[0] === 'create');

  assert.ok(create);
  assert.match(first.sandboxName, /^cloudcli-claude-My-App-[0-9a-f]{8}$/);
  assert.deepEqual(create.argumentsList, ['create', '--name', first.sandboxName, 'claude', '/work/My App']);
});

test('prepareClaudeRun surfaces a failed sandbox creation', async () => {
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'ls') return { stdout: sandboxList([]) };
    if (argumentsList[0] === 'create') return { exitCode: 1, stderr: 'no docker daemon' };
    return {};
  });

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null }),
    /no docker daemon/,
  );
});

test('resuming seeds the sandbox with the host transcript only when the sandbox lacks it', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const transcriptDirectory = path.join(homeDirectory, '.claude', 'projects', '-work-app');
  await fs.mkdir(transcriptDirectory, { recursive: true });
  await fs.writeFile(path.join(transcriptDirectory, 'abc-123.jsonl'), '{"type":"user"}\n');

  let sandboxHasTranscript = false;
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'ls') return { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) };
    if (argumentsList[0] === 'exec' && argumentsList.at(-1)?.startsWith('test -f')) {
      return { exitCode: sandboxHasTranscript ? 0 : 1 };
    }
    return {};
  }, homeDirectory);

  await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: 'abc-123' });
  const copy = harness.calls.find((call) => call.stdin !== undefined);
  assert.ok(copy, 'expected the transcript to be piped into the sandbox');
  assert.equal(copy.stdin, '{"type":"user"}\n');
  assert.deepEqual(copy.argumentsList.slice(0, 3), ['exec', '-i', 'box']);
  assert.match(copy.argumentsList.at(-1) ?? '', /\$HOME\/\.claude\/projects\/-work-app\/abc-123\.jsonl/);

  sandboxHasTranscript = true;
  harness.calls.length = 0;
  await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: 'abc-123' });
  assert.equal(harness.calls.some((call) => call.stdin !== undefined), false);
});

test('syncTranscriptToHost writes the sandbox transcript into the host projects directory', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'ls') return { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) };
    if (argumentsList[0] === 'exec' && argumentsList.at(-1)?.startsWith('cat ')) {
      return { stdout: '{"type":"assistant"}\n' };
    }
    return {};
  }, homeDirectory);

  const run = await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });
  await run.syncTranscriptToHost('sess-1');

  const written = await fs.readFile(
    path.join(homeDirectory, '.claude', 'projects', '-work-app', 'sess-1.jsonl'),
    'utf8',
  );
  assert.equal(written, '{"type":"assistant"}\n');
  await assert.rejects(run.syncTranscriptToHost('../escape'), /unsafe session id/);
});

test('spawnClaudeCodeProcess execs claude in the sandbox with only the CLI flags and SDK env', async () => {
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'ls' ? { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) } : {}
  ));
  const run = await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });
  const controller = new AbortController();

  const child = run.spawnClaudeCodeProcess({
    command: '/usr/bin/node',
    args: ['--no-warnings', '/opt/sdk/cli.js', '--output-format', 'stream-json', '--verbose'],
    cwd: '/work/app',
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.0',
      CLAUDE_CONFIG_DIR: '/home/host/.claude',
      ANTHROPIC_API_KEY: 'secret',
      PATH: '/usr/bin',
    },
    signal: controller.signal,
  });

  assert.deepEqual(harness.spawned, [[
    'exec', '-i', '-w', '/work/app',
    '-e', 'CLAUDE_CODE_ENTRYPOINT=sdk-ts',
    '-e', 'CLAUDE_AGENT_SDK_VERSION=0.3.0',
    'box', 'claude', '--output-format', 'stream-json', '--verbose',
  ]]);

  controller.abort();
  assert.equal(child.killed, true);
});

test('spawnClaudeCodeProcess keeps every argument for a native CLI binary', async () => {
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'ls' ? { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) } : {}
  ));
  const run = await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });

  run.spawnClaudeCodeProcess({
    command: '/home/host/.local/bin/claude',
    args: ['--output-format', 'stream-json', '--mcp-config', 'servers.js'],
    env: {},
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    harness.spawned[0].slice(-5),
    ['claude', '--output-format', 'stream-json', '--mcp-config', 'servers.js'],
  );
});

// ----- Codex

const CODEX_AUTH_OLD = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old' }, last_refresh: '2026-09-15T01:00:00Z' });
const CODEX_AUTH_NEW = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new' }, last_refresh: '2026-09-15T02:00:00Z' });

/** A sandbox that answers the Codex file probes from an in-memory map of `$HOME/.codex`-relative paths. */
function createCodexSandboxFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const respond = (argumentsList: string[], stdin?: string): FakeSbxResponse => {
    if (argumentsList[0] === 'ls') return { stdout: sandboxList([{ name: 'cbox', agent: 'codex', workspaces: ['/work/app'] }]) };
    if (argumentsList[0] !== 'exec') return {};
    const script = argumentsList.at(-1) ?? '';
    const pathMatch = script.match(/"\$HOME\/\.codex\/([^"]+)"/);
    const relativePath = pathMatch?.[1];
    if (script.startsWith('cat ') && relativePath) {
      return files.has(relativePath) ? { stdout: files.get(relativePath) } : { exitCode: 1 };
    }
    if (script.includes('cat > ') && relativePath && stdin !== undefined) {
      files.set(relativePath, stdin);
      return {};
    }
    if (script.includes('find sessions')) {
      const threadId = script.match(/rollout-\*-([\w-]+)\.jsonl/)?.[1];
      const found = [...files.keys()].find((key) => key.startsWith('sessions/') && key.endsWith(`-${threadId}.jsonl`));
      return { stdout: found ? `${found}\n` : '' };
    }
    return {};
  };
  return { files, respond };
}

test('prepareCodexRun creates a codex sandbox and a launcher script the SDK can execute', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const scratchDirectory = path.join(homeDirectory, 'scratch');
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'ls' ? { stdout: sandboxList([]) } : {}
  ), homeDirectory, scratchDirectory);

  const run = await harness.service.prepareCodexRun({ cwd: '/work/app', providerSessionId: null });

  const create = harness.calls.find((call) => call.argumentsList[0] === 'create');
  assert.deepEqual(create?.argumentsList, ['create', '--name', run.sandboxName, 'codex', '/work/app']);
  assert.match(run.sandboxName, /^cloudcli-codex-app-[0-9a-f]{8}$/);

  const script = await fs.readFile(run.codexExecutablePath, 'utf8');
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, new RegExp(`exec sbx exec -i -w '/work/app' .* '${run.sandboxName}' codex "\\$@"`));
  const mode = (await fs.stat(run.codexExecutablePath)).mode & 0o777;
  assert.equal(mode & 0o100, 0o100, 'launcher must be executable');
});

test('prepareCodexRun pushes the newer host login into the sandbox and leaves a newer sandbox login alone', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  await fs.mkdir(path.join(homeDirectory, '.codex'), { recursive: true });
  await fs.writeFile(path.join(homeDirectory, '.codex', 'auth.json'), CODEX_AUTH_NEW);

  const sandbox = createCodexSandboxFiles({ 'auth.json': CODEX_AUTH_OLD });
  const harness = createHarness(sandbox.respond, homeDirectory);
  await harness.service.prepareCodexRun({ cwd: '/work/app', providerSessionId: null });
  assert.equal(sandbox.files.get('auth.json'), CODEX_AUTH_NEW);

  // Host is now older than the sandbox: the sandbox copy must win and land on the host.
  await fs.writeFile(path.join(homeDirectory, '.codex', 'auth.json'), CODEX_AUTH_OLD);
  const run = await harness.service.prepareCodexRun({ cwd: '/work/app', providerSessionId: null });
  assert.equal(sandbox.files.get('auth.json'), CODEX_AUTH_NEW);
  assert.equal(await fs.readFile(path.join(homeDirectory, '.codex', 'auth.json'), 'utf8'), CODEX_AUTH_NEW);

  // A refresh inside the sandbox during the turn is pulled back afterwards.
  const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'r' }, last_refresh: '2026-09-15T03:00:00Z' });
  sandbox.files.set('auth.json', refreshed);
  await run.syncToHost(null);
  assert.equal(await fs.readFile(path.join(homeDirectory, '.codex', 'auth.json'), 'utf8'), refreshed);
});

test('prepareCodexRun does not touch the sandbox login when the host has none', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const sandbox = createCodexSandboxFiles({ 'auth.json': CODEX_AUTH_OLD });
  const harness = createHarness(sandbox.respond, homeDirectory);

  await harness.service.prepareCodexRun({ cwd: '/work/app', providerSessionId: null });

  assert.equal(sandbox.files.get('auth.json'), CODEX_AUTH_OLD);
});

test('codex rollouts move between the host and sandbox date trees by thread id', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const hostDay = path.join(homeDirectory, '.codex', 'sessions', '2026', '09', '14');
  await fs.mkdir(hostDay, { recursive: true });
  await fs.writeFile(path.join(hostDay, 'rollout-2026-09-14T10-00-00-thread-a.jsonl'), '{"host":true}\n');

  const sandbox = createCodexSandboxFiles({});
  const harness = createHarness(sandbox.respond, homeDirectory);

  // Resuming a host-only thread seeds the sandbox at the same relative path.
  const run = await harness.service.prepareCodexRun({ cwd: '/work/app', providerSessionId: 'thread-a' });
  assert.equal(sandbox.files.get('sessions/2026/09/14/rollout-2026-09-14T10-00-00-thread-a.jsonl'), '{"host":true}\n');

  // A thread the sandbox created lands on the host in the sandbox's date directory.
  sandbox.files.set('sessions/2026/09/15/rollout-2026-09-15T09-00-00-thread-b.jsonl', '{"sandbox":true}\n');
  await run.syncToHost('thread-b');
  assert.equal(
    await fs.readFile(path.join(homeDirectory, '.codex', 'sessions', '2026', '09', '15', 'rollout-2026-09-15T09-00-00-thread-b.jsonl'), 'utf8'),
    '{"sandbox":true}\n',
  );
  await assert.rejects(run.syncToHost('../escape'), /unsafe session id/);
});

test('attachments are copied to the same absolute path inside the sandbox', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const attachment = path.join(homeDirectory, 'assets', 'note.txt');
  await fs.mkdir(path.dirname(attachment), { recursive: true });
  await fs.writeFile(attachment, 'hello');

  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'ls' ? { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) } : {}
  ), homeDirectory);
  await harness.service.prepareClaudeRun({
    cwd: '/work/app',
    providerSessionId: null,
    attachmentPaths: [attachment, 'relative/ignored.txt', path.join(homeDirectory, 'missing.txt')],
  });

  const copies = harness.calls.filter((call) => call.argumentsList.at(-1)?.includes('base64 -d'));
  assert.equal(copies.length, 1);
  assert.ok(copies[0].argumentsList.at(-1)?.includes(`'${attachment}'`));
  assert.equal(copies[0].stdin, Buffer.from('hello').toString('base64'));
});

// ----- Templates

const TEMPLATE_LIST = JSON.stringify({
  images: [
    { id: 'a', repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code-docker', flavor: 'claude-code-docker', created_at: '2026-09-15T05:14:54Z', size: 10 },
    { id: 'b', repository: 'docker.io/acme/custom', tag: 'v2', flavor: null, created_at: '2026-09-15T09:37:13Z', size: 20 },
  ],
});

test('listTemplates returns image references newest first', async () => {
  const harness = createHarness((argumentsList) => (
    argumentsList[0] === 'template' ? { stdout: TEMPLATE_LIST } : {}
  ));

  const templates = await harness.service.listTemplates();

  assert.deepEqual(templates.map((template) => template.reference), [
    'docker.io/acme/custom:v2',
    'docker.io/docker/sandbox-templates:claude-code-docker',
  ]);
  assert.equal(templates[1].flavor, 'claude-code-docker');
  assert.equal(templates[1].sizeBytes, 10);
});

const CUSTOM_TEMPLATE_LS = JSON.stringify({
  images: [{ id: 'bbb222bbb222', repository: 'docker.io/acme/custom', tag: 'v2', flavor: 'claude-code-docker', created_at: '2026-09-15T09:37:13Z', size: 20 }],
});

test('a template gets its own sandbox created from that image and is not confused with the default one', async () => {
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'template') return { stdout: CUSTOM_TEMPLATE_LS };
    return argumentsList[0] === 'ls'
      ? { stdout: sandboxList([{ name: 'claude-test', workspaces: ['/work/app'] }]) }
      : {};
  });

  const templated = await harness.service.prepareClaudeRun({
    cwd: '/work/app',
    providerSessionId: null,
    template: 'docker.io/acme/custom:v2',
  });

  assert.notEqual(templated.sandboxName, 'claude-test', 'the user default sandbox must not be reused for a template');
  const create = harness.calls.find((call) => call.argumentsList[0] === 'create');
  assert.deepEqual(create?.argumentsList, [
    'create', '--template', 'docker.io/acme/custom:v2', '--name', templated.sandboxName, 'claude', '/work/app',
  ]);

  // Same template again resolves to the same, now existing, sandbox without creating another.
  harness.calls.length = 0;
  const again = createHarness((argumentsList) => {
    if (argumentsList[0] === 'template') return { stdout: CUSTOM_TEMPLATE_LS };
    return argumentsList[0] === 'ls'
      ? { stdout: sandboxList([{ name: 'claude-test', workspaces: ['/work/app'] }, { name: templated.sandboxName, workspaces: ['/work/app'] }]) }
      : {};
  });
  const reused = await again.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null, template: 'docker.io/acme/custom:v2' });
  assert.equal(reused.sandboxName, templated.sandboxName);
  assert.equal(again.calls.some((call) => call.argumentsList[0] === 'create'), false);
});

test('an unsafe template reference is rejected before any sbx call', async () => {
  const harness = createHarness(() => ({}));

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null, template: 'evil; rm -rf /' }),
    /Invalid sandbox template reference/,
  );
  assert.equal(harness.calls.some((call) => call.argumentsList[0] === 'create'), false);
});

// ----- Claude subscription login

const CLAUDE_CRED_OLD = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: 1_000 } });
const CLAUDE_CRED_NEW = JSON.stringify({ claudeAiOauth: { accessToken: 'new', refreshToken: 'r2', expiresAt: 2_000 } });

/** A claude sandbox answering credential probes from an in-memory `$HOME/.claude`-relative map. */
function createClaudeSandboxFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const respond = (argumentsList: string[], stdin?: string): FakeSbxResponse => {
    if (argumentsList[0] === 'ls') return { stdout: sandboxList([{ name: 'box', workspaces: ['/work/app'] }]) };
    if (argumentsList[0] !== 'exec') return {};
    const script = argumentsList.at(-1) ?? '';
    const relativePath = script.match(/"\$HOME\/\.claude\/([^"]+)"/)?.[1];
    if (script.startsWith('cat ') && relativePath) {
      return files.has(relativePath) ? { stdout: files.get(relativePath) } : { exitCode: 1 };
    }
    if (script.includes('cat > ') && relativePath && stdin !== undefined) {
      files.set(relativePath, stdin);
      return {};
    }
    return {};
  };
  return { files, respond };
}

test('prepareClaudeRun seeds a fresh sandbox with the host OAuth login and pulls a refreshed one back', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  await fs.mkdir(path.join(homeDirectory, '.claude'), { recursive: true });
  await fs.writeFile(path.join(homeDirectory, '.claude', '.credentials.json'), CLAUDE_CRED_OLD);

  const sandbox = createClaudeSandboxFiles({});
  const harness = createHarness(sandbox.respond, homeDirectory);
  const run = await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });
  assert.equal(sandbox.files.get('.credentials.json'), CLAUDE_CRED_OLD, 'a sandbox without a login gets the host copy');

  // The CLI refreshed the token inside the sandbox: the host copy is now stale.
  sandbox.files.set('.credentials.json', CLAUDE_CRED_NEW);
  await run.syncCredentialsToHost();
  assert.equal(await fs.readFile(path.join(homeDirectory, '.claude', '.credentials.json'), 'utf8'), CLAUDE_CRED_NEW);

  // And an older host copy never clobbers the newer sandbox login.
  await fs.writeFile(path.join(homeDirectory, '.claude', '.credentials.json'), CLAUDE_CRED_OLD);
  await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });
  assert.equal(sandbox.files.get('.credentials.json'), CLAUDE_CRED_NEW);
});

test('prepareClaudeRun leaves the sandbox login alone when the host has none (API-key hosts)', async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-'));
  const sandbox = createClaudeSandboxFiles({ '.credentials.json': CLAUDE_CRED_OLD });
  const harness = createHarness(sandbox.respond, homeDirectory);

  await harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null });

  assert.equal(sandbox.files.get('.credentials.json'), CLAUDE_CRED_OLD);
  assert.equal(harness.calls.some((call) => call.argumentsList.at(-1)?.includes('cat > "$HOME/.claude/.credentials.json"')), false);
});

// ----- Docker images → templates

const DOCKER_IMAGES = [
  { ID: 'aaa111aaa111', Repository: 'docker/sandbox-templates', Tag: 'claude-code', Size: '953MB', CreatedAt: '2026-09-15 05:14:54 +0000 UTC' },
  { ID: 'bbb222bbb222', Repository: 'acme/custom', Tag: 'v2', Size: '1.2GB', CreatedAt: '2026-09-15 09:37:13 +0000 UTC' },
  { ID: 'ccc333ccc333', Repository: '<none>', Tag: '<none>', Size: '10MB', CreatedAt: '2026-09-15 10:00:00 +0000 UTC' },
].map((record) => JSON.stringify(record)).join('\n');

/**
 * `docker image inspect --format '{{.Id}}\t{{json .Config}}'` output. The
 * third image has no `Labels` key at all, which is exactly the shape that
 * used to make the whole call fail and drop every flavor.
 */
const DOCKER_INSPECT = [
  `sha256:aaa111aaa111000000000000000000000000000000000000000000000000000\t${JSON.stringify({ Labels: { 'com.docker.sandboxes.flavor': 'claude-code-docker' } })}`,
  `sha256:bbb222bbb222000000000000000000000000000000000000000000000000000\t${JSON.stringify({ Labels: { 'com.docker.sandboxes.flavor': 'claude-code-docker' } })}`,
  `sha256:ddd444ddd444000000000000000000000000000000000000000000000000000\t${JSON.stringify({ Cmd: ['postgres'] })}`,
].join('\n');

const respondDockerWithFlavors = (argumentsList: string[]): FakeSbxResponse => {
  if (argumentsList[0] === 'images') return { stdout: DOCKER_IMAGES };
  // docker exits non-zero when any image in the batch has no labels; the
  // readable lines must still be used.
  if (argumentsList[0] === 'image' && argumentsList[1] === 'inspect') return { exitCode: 1, stdout: DOCKER_INSPECT, stderr: 'template parsing error' };
  return {};
};

const TEMPLATE_WITH_CLAUDE = JSON.stringify({
  images: [{ id: 'aaa111aaa111', repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code', created_at: '2026-09-15T05:14:54Z', size: 10 }],
});

test('listDockerImages skips dangling images and marks the ones already loaded as templates', async () => {
  const harness = createHarness(
    (argumentsList) => (argumentsList[0] === 'template' ? { stdout: TEMPLATE_WITH_CLAUDE } : {}),
    '/home/host',
    '/tmp/cloudcli-sandbox-test-scratch',
    respondDockerWithFlavors,
  );

  const images = await harness.service.listDockerImages();

  assert.deepEqual(images.map((image) => image.reference), ['acme/custom:v2', 'docker/sandbox-templates:claude-code']);
  assert.equal(images[1].templateReference, 'docker.io/docker/sandbox-templates:claude-code');
  assert.equal(images[0].templateReference, null);
  assert.equal(images[0].size, '1.2GB');
});

test('importDockerImageAsTemplate exports, loads, cleans up and returns the template found by image id', async () => {
  const scratchDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-sandbox-scratch-'));
  let loaded = false;
  const harness = createHarness(
    (argumentsList) => {
      if (argumentsList[0] === 'template' && argumentsList[1] === 'ls') {
        return {
          stdout: loaded
            ? JSON.stringify({ images: [{ id: 'bbb222bbb222', repository: 'docker.io/acme/custom', tag: 'v2', created_at: '2026-09-15T09:37:13Z', size: 20 }] })
            : JSON.stringify({ images: [] }),
        };
      }
      if (argumentsList[0] === 'template' && argumentsList[1] === 'load') {
        loaded = true;
        return {};
      }
      return {};
    },
    '/home/host',
    scratchDirectory,
    (argumentsList) => {
      if (argumentsList[0] === 'save') {
        // Pretend docker wrote the tar so the cleanup has something to remove.
        fs.writeFile(argumentsList[3], 'tar').catch(() => undefined);
        return {};
      }
      return respondDockerWithFlavors(argumentsList);
    },
  );

  const template = await harness.service.importDockerImageAsTemplate('acme/custom:v2');

  assert.equal(template.reference, 'docker.io/acme/custom:v2');
  const save = harness.dockerCalls.find((call) => call[0] === 'save');
  assert.deepEqual(save?.slice(0, 2), ['save', 'acme/custom:v2']);
  const tarPath = save?.[3] as string;
  assert.ok(tarPath.startsWith(scratchDirectory));
  const load = harness.calls.find((call) => call.argumentsList[0] === 'template' && call.argumentsList[1] === 'load');
  assert.deepEqual(load?.argumentsList, ['template', 'load', tarPath]);
  await assert.rejects(fs.stat(tarPath), 'the exported tar must be removed afterwards');
});

test('importDockerImageAsTemplate returns the existing template without exporting again', async () => {
  const harness = createHarness(
    (argumentsList) => (argumentsList[0] === 'template' ? { stdout: TEMPLATE_WITH_CLAUDE } : {}),
    '/home/host',
    '/tmp/cloudcli-sandbox-test-scratch',
    respondDockerWithFlavors,
  );

  const template = await harness.service.importDockerImageAsTemplate('docker/sandbox-templates:claude-code');

  assert.equal(template.reference, 'docker.io/docker/sandbox-templates:claude-code');
  assert.equal(harness.dockerCalls.some((call) => call[0] === 'save'), false);
});

test('importDockerImageAsTemplate rejects unknown or unsafe references before touching docker', async () => {
  const harness = createHarness(
    () => ({ stdout: JSON.stringify({ images: [] }) }),
    '/home/host',
    '/tmp/cloudcli-sandbox-test-scratch',
    respondDockerWithFlavors,
  );

  await assert.rejects(harness.service.importDockerImageAsTemplate('evil; rm -rf /'), /Invalid Docker image reference/);
  await assert.rejects(harness.service.importDockerImageAsTemplate('ghost/image:1'), /not found locally/);
  assert.equal(harness.dockerCalls.some((call) => call[0] === 'save'), false);
});

// ----- Agent-kit compatibility

test('listDockerImages reports the agent flavor label so incompatible images can be greyed out', async () => {
  const harness = createHarness(
    (argumentsList) => (argumentsList[0] === 'template' ? { stdout: JSON.stringify({ images: [] }) } : {}),
    '/home/host',
    '/tmp/cloudcli-sandbox-test-scratch',
    respondDockerWithFlavors,
  );

  const images = await harness.service.listDockerImages();
  const byReference = new Map(images.map((image) => [image.reference, image]));

  assert.equal(byReference.get('acme/custom:v2')?.agentFlavor, 'claude-code-docker');
  assert.equal(byReference.get('docker/sandbox-templates:claude-code')?.agentFlavor, 'claude-code-docker');
});

test('an image with no labels leaves the other flavors intact', async () => {
  const harness = createHarness(
    (argumentsList) => (argumentsList[0] === 'template' ? { stdout: JSON.stringify({ images: [] }) } : {}),
    '/home/host',
    '/tmp/cloudcli-sandbox-test-scratch',
    respondDockerWithFlavors,
  );

  const images = await harness.service.listDockerImages();

  assert.equal(images.filter((image) => image.agentFlavor !== null).length, 2);
});

test('a template that cannot host the agent is refused with an actionable error, not a bare sbx failure', async () => {
  // Reproduces the redis:7-alpine case: `sbx template load` accepts any image,
  // but `sbx create` then dies with "failed to apply kit to sandbox".
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'template') {
      return {
        stdout: JSON.stringify({
          images: [{ id: 'ff02b58f971e', repository: 'docker.io/library/redis', tag: '7-alpine', flavor: null, created_at: '2026-09-15T16:47:00Z', size: 10 }],
        }),
      };
    }
    return argumentsList[0] === 'ls' ? { stdout: sandboxList([]) } : {};
  });

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null, template: 'docker.io/library/redis:7-alpine' }),
    /cannot run claude.*com\.docker\.sandboxes\.flavor/s,
  );
  assert.equal(harness.calls.some((call) => call.argumentsList[0] === 'create'), false, 'no sandbox may be created from an unusable image');
});

test('a template missing from the image store asks for a re-import instead of failing obscurely', async () => {
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'template') return { stdout: JSON.stringify({ images: [] }) };
    return argumentsList[0] === 'ls' ? { stdout: sandboxList([]) } : {};
  });

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null, template: 'docker.io/acme/gone:1' }),
    /no longer in the sandbox image store/,
  );
});

test('a codex-flavored image is refused for a claude run', async () => {
  const harness = createHarness((argumentsList) => {
    if (argumentsList[0] === 'template') {
      return {
        stdout: JSON.stringify({
          images: [{ id: 'ccc', repository: 'docker.io/acme/codexbase', tag: '1', flavor: 'codex-docker', created_at: '2026-09-15T09:00:00Z', size: 10 }],
        }),
      };
    }
    return argumentsList[0] === 'ls' ? { stdout: sandboxList([]) } : {};
  });

  await assert.rejects(
    harness.service.prepareClaudeRun({ cwd: '/work/app', providerSessionId: null, template: 'docker.io/acme/codexbase:1' }),
    /cannot run claude/,
  );
});
