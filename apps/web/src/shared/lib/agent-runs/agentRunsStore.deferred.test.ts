import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: { ok: true } })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { applyEvent } from './agent-runs.events';
import type { AgentRun } from './agent-runs.types';
import { runs } from './agent-runs.state.constants';
import { decidePermission } from './decidePermission';
import { getChatStatuses } from './agent-runs.statuses';

/**
 * Карточка прав, не дождавшаяся ответа за срок, стала D-n (решение 1): сервер
 * шлёт `permissionResolved` с `deferredId`. Вкладка убирает её из ждущих — агент
 * работает дальше, «ждёт вас» гаснет, — но держит в ленте с номером записи, и
 * ответ на неё уходит тем же маршрутом.
 */
function seed(id: string): void {
  runs.set(id, {
    id,
    status: 'running',
    text: '',
    thinking: '',
    tools: [],
    permissions: [],
    branchGates: [],
    queued: [],
    tokens: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  } as unknown as AgentRun);
}

const CARD = {
  kind: 'permission',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  toolUseId: 'tu-1',
} as const;

describe('карточка прав, отложенная как D-n', () => {
  afterEach(() => runs.clear());

  it('`permissionResolved` с номером — карточка переезжает в отложенные, «ждёт вас» гаснет', () => {
    seed('a');
    applyEvent('a', CARD);
    expect(getChatStatuses().get('a')).toBe('waiting');
    applyEvent('a', {
      kind: 'permissionResolved',
      toolUseId: 'tu-1',
      behavior: 'deny',
      deferredId: 'D-4',
    });
    const run = runs.get('a');
    expect(run?.permissions).toEqual([]);
    expect(run?.deferredPermissions).toEqual([
      {
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        toolUseId: 'tu-1',
        deferredId: 'D-4',
      },
    ]);
    expect(getChatStatuses().get('a')).toBe('running');
  });

  it('обычный ответ без номера — карточка просто уходит, в отложенные не попадает', () => {
    seed('b');
    applyEvent('b', CARD);
    applyEvent('b', { kind: 'permissionResolved', toolUseId: 'tu-1', behavior: 'allow' });
    expect(runs.get('b')?.permissions).toEqual([]);
    expect(runs.get('b')?.deferredPermissions).toBeUndefined();
  });

  it('ответ человека на отложенную карточку убирает её из ленты', () => {
    seed('c');
    applyEvent('c', CARD);
    applyEvent('c', {
      kind: 'permissionResolved',
      toolUseId: 'tu-1',
      behavior: 'deny',
      deferredId: 'D-4',
    });
    decidePermission('c', 'tu-1', 'allow');
    expect(runs.get('c')?.deferredPermissions).toEqual([]);
  });

  it('новый ход — отложенные карточки прошлого из ленты уходят (их держит список)', () => {
    seed('d');
    applyEvent('d', CARD);
    applyEvent('d', {
      kind: 'permissionResolved',
      toolUseId: 'tu-1',
      behavior: 'deny',
      deferredId: 'D-4',
    });
    applyEvent('d', {
      kind: 'session',
      sessionId: 's-2',
      model: 'claude-opus-5',
      tools: 0,
      startedAt: 1,
    });
    expect(runs.get('d')?.deferredPermissions ?? []).toEqual([]);
  });
});
