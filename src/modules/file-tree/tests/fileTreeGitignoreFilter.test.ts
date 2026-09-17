import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useFileTreeGitignoreFilter } from '@/modules/file-tree/hooks/useFileTreeGitignoreFilter';

/**
 * The Files toolbar toggle and the request it produces.
 *
 * The off case is the one worth pinning: `query()` drops `false`, so turning
 * the filter off sends no `respectGitignore` parameter at all, and the route
 * reads an absent parameter as false. A change that made `query()` serialize
 * false, or made the route default to true, would silently keep ignored files
 * hidden with the toggle visibly switched off.
 */

beforeEach(() => {
  localStorage.clear();
});

test('a fresh install filters the tree through .gitignore', () => {
  const { result } = renderHook(() => useFileTreeGitignoreFilter());

  assert.equal(result.current.respectGitignore, true);
});

test('turning the filter off survives a remount', () => {
  const { result, unmount } = renderHook(() => useFileTreeGitignoreFilter());

  act(() => {
    result.current.changeRespectGitignore(false);
  });
  assert.equal(result.current.respectGitignore, false);
  unmount();

  const remounted = renderHook(() => useFileTreeGitignoreFilter());
  assert.equal(remounted.result.current.respectGitignore, false);
});

test('an unreadable stored value falls back to filtering', () => {
  localStorage.setItem('file-tree-respect-gitignore', 'maybe');

  const { result } = renderHook(() => useFileTreeGitignoreFilter());

  assert.equal(result.current.respectGitignore, true);
});

const requestedUrl = async (respectGitignore?: boolean) => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);

  const { api } = await import('@/shared/api');
  await api.getFiles('project-1', respectGitignore === undefined ? {} : { respectGitignore });

  return String(fetchMock.mock.calls[0][0]);
};

test('the filtered tree asks for respectGitignore=true', async () => {
  assert.match(await requestedUrl(true), /\?respectGitignore=true$/);
});

test('callers that pass no preference still get the filtered tree', async () => {
  assert.match(await requestedUrl(), /\?respectGitignore=true$/);
});

test('the unfiltered tree sends no respectGitignore parameter', async () => {
  const url = await requestedUrl(false);

  assert.equal(url.includes('respectGitignore'), false);
  assert.match(url, /\/api\/file-tree\/projects\/project-1\/files$/);
});
