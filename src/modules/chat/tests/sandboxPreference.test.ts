import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSandboxPreference } from '@/modules/chat/hooks/useSandboxPreference';
import type { PermissionMode, Project, ProjectSession, SandboxImageOption } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The composer's Docker sandbox toggle: the choice sticks to the session and
 * project it was made in, it only counts as "on" once the server confirmed
 * `sbx` works, and every `chat.send` carries the resulting `sandbox` flag.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

let importRequests = 0;

/** Answers the sandbox status probe with `available`; every other fetch gets an empty list. */
const stubFetch = (available: boolean) => {
  importRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/sandbox/templates/import')) {
        importRequests += 1;
        return jsonResponse({ success: true, data: { template: { reference: 'docker.io/acme/fresh:v1' } } });
      }
      if (url.includes('/api/sandbox/images')) {
        return jsonResponse({
          success: true,
          data: {
            images: [
              { reference: 'acme/custom:v2', repository: 'acme/custom', tag: 'v2', id: 'aaa', size: '1.2GB', createdAt: null, templateReference: 'docker.io/acme/custom:v2', agentFlavor: 'claude-code-docker' },
              { reference: 'acme/fresh:v1', repository: 'acme/fresh', tag: 'v1', id: 'bbb', size: '900MB', createdAt: null, templateReference: null, agentFlavor: 'claude-code-docker' },
            ],
          },
        });
      }
      if (url.includes('/api/sandbox/status')) {
        return jsonResponse({
          success: true,
          data: { available, version: available ? '0.42.1' : null, error: available ? null : 'sbx not found' },
        });
      }
      return jsonResponse([]);
    }),
  );
};

beforeEach(() => {
  resetUserPreferences();
  localStorage.clear();
  // The availability probe is memoised per page load; each case needs a fresh one.
  vi.resetModules();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderPreference = async (
  available: boolean,
  session: ProjectSession | null = SESSION,
  provider = 'claude',
) => {
  stubFetch(available);
  const { useSandboxPreference: useFreshSandboxPreference } = await import('@/modules/chat/hooks/useSandboxPreference');
  const view = renderHook(() => useFreshSandboxPreference({
    selectedProject: PROJECT,
    selectedSession: session,
    supported: true,
    provider,
  }));
  await waitFor(() => assert.equal(view.result.current.sandboxChecking, false));
  return view;
};

test('picking a template remembers the choice for the session and the project', async () => {
  const view = await renderPreference(true);
  assert.equal(view.result.current.sandboxEnabled, false);

  act(() => view.result.current.selectSandboxTemplate('docker.io/acme/custom:v2'));

  assert.equal(view.result.current.sandboxEnabled, true);
  assert.equal(view.result.current.sandboxTemplate, 'docker.io/acme/custom:v2');
  assert.deepEqual(JSON.parse(localStorage.getItem('sandbox-session-1') ?? ''), { enabled: true, template: 'docker.io/acme/custom:v2', provider: 'claude' });
  assert.deepEqual(JSON.parse(localStorage.getItem('sandbox-last-/tmp/project-one') ?? ''), { enabled: true, template: 'docker.io/acme/custom:v2', provider: 'claude' });

  act(() => view.result.current.selectSandboxTemplate(null));
  assert.equal(view.result.current.sandboxEnabled, true);
  assert.equal(view.result.current.sandboxTemplate, null);

  act(() => view.result.current.disableSandbox());
  assert.equal(view.result.current.sandboxEnabled, false);
  assert.deepEqual(JSON.parse(localStorage.getItem('sandbox-session-1') ?? ''), { enabled: false, template: null, provider: null });
});

test('a template picked for one agent is dropped when another agent takes over, leaving the default image', async () => {
  const claude = await renderPreference(true);
  act(() => claude.result.current.selectSandboxTemplate('docker.io/acme/custom:v2'));
  assert.equal(claude.result.current.sandboxTemplate, 'docker.io/acme/custom:v2');

  // A claude-flavored image carries no codex kit, so the server would refuse
  // the run; the switch stays on and falls back to codex's own sbx image.
  const codex = await renderPreference(true, SESSION, 'codex');
  assert.equal(codex.result.current.sandboxRequested, true);
  assert.equal(codex.result.current.sandboxEnabled, true);
  assert.equal(codex.result.current.sandboxTemplate, null);

  // Switching back finds the claude choice still recorded.
  const back = await renderPreference(true);
  assert.equal(back.result.current.sandboxTemplate, 'docker.io/acme/custom:v2');
});

test('Docker images load on demand and an already-imported image is selected without an import round trip', async () => {
  const view = await renderPreference(true);
  assert.equal(view.result.current.sandboxImages, null);

  await act(async () => {
    await view.result.current.loadSandboxImages();
  });

  // Widened explicitly: the null assertion above narrows the field to `never`.
  const loaded = view.result.current.sandboxImages as SandboxImageOption[] | null;
  assert.deepEqual(loaded?.map((image) => image.reference), ['acme/custom:v2', 'acme/fresh:v1']);
  assert.equal(view.result.current.sandboxImagesError, null);

  await act(async () => {
    await view.result.current.selectSandboxImage(loaded![0]);
  });
  assert.equal(importRequests, 0);
  assert.equal(view.result.current.sandboxEnabled, true);
  assert.equal(view.result.current.sandboxTemplate, 'docker.io/acme/custom:v2');
});

test('selecting an image that is not a template yet imports it and remembers the template the store returned', async () => {
  const view = await renderPreference(true);
  await act(async () => {
    await view.result.current.loadSandboxImages();
  });
  const fresh = (view.result.current.sandboxImages as SandboxImageOption[])[1];

  await act(async () => {
    await view.result.current.selectSandboxImage(fresh);
  });

  assert.equal(importRequests, 1);
  assert.equal(view.result.current.sandboxImportingImage, null);
  assert.equal(view.result.current.sandboxImportError, null);
  assert.equal(view.result.current.sandboxTemplate, 'docker.io/acme/fresh:v1');
  assert.equal(view.result.current.sandboxEnabled, true);
  const updated = (view.result.current.sandboxImages as SandboxImageOption[]).find((image) => image.reference === 'acme/fresh:v1');
  assert.equal(updated?.templateReference, 'docker.io/acme/fresh:v1', 'the list reflects the import so the row reads as ready');
});

test('a new chat inherits the project choice until it has its own, and legacy true/false values still read', async () => {
  localStorage.setItem('sandbox-last-/tmp/project-one', 'true');
  localStorage.setItem('sandbox-session-2', 'false');

  const fresh = await renderPreference(true, null);
  assert.equal(fresh.result.current.sandboxEnabled, true);

  const other = await renderPreference(true, { id: 'session-2' });
  assert.equal(other.result.current.sandboxEnabled, false);
});

test('the switch never counts as enabled while sbx is unavailable', async () => {
  localStorage.setItem('sandbox-session-1', JSON.stringify({ enabled: true, template: null }));
  const view = await renderPreference(false);

  assert.equal(view.result.current.sandboxRequested, true);
  assert.equal(view.result.current.sandboxAvailable, false);
  assert.equal(view.result.current.sandboxEnabled, false);
  assert.equal(view.result.current.sandboxUnavailableReason, 'sbx not found');
});

test('the composer forwards the sandbox flag and template on chat.send', async () => {
  stubFetch(true);
  const sent: Array<{ type: string; options?: { sandbox?: boolean; sandboxTemplate?: string | null } }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      sandboxEnabled: true,
      sandboxTemplate: 'docker.io/acme/custom:v2',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        sent.push(message as { type: string; options?: { sandbox?: boolean; sandboxTemplate?: string | null } });
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  await act(async () => {
    view.result.current.setInput('hello');
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  const send = sent.find((message) => message.type === 'chat.send');
  assert.ok(send, 'expected the composer to dispatch a chat.send');
  assert.equal(send.options?.sandbox, true);
  assert.equal(send.options?.sandboxTemplate, 'docker.io/acme/custom:v2');
});

// Keeps the static import above meaningful for type-checking of the hook's public shape.
void useSandboxPreference;
