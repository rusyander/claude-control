import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: { defaults: { baseURL: '/api' }, post: vi.fn(), get: vi.fn() },
}));

import { MAX_STREAMS } from './agent-runs.constants';
import { budget, priority, setWatched } from './agent-runs.slots';
import { callbacks, runs, sending, setRun } from './agent-runs.state';
import type { AgentRun } from './agent-runs.types';

/**
 * Очередь за потоком: кто важнее, тот и держит соединение.
 *
 * Порядок — не вкусовщина: отправка обязана уйти (обрыв до ответа = непринятое
 * сообщение), открытый разговор человек читает прямо сейчас, ждущий человека
 * прогон стоит, пока ему не ответят, а ответить можно только увидев вопрос —
 * он же приходит потоком. Остальное может подождать.
 */
describe('priority — место прогона в очереди за потоком', () => {
  const put = (id: string, patch: Partial<AgentRun> = {}): AgentRun => {
    setRun(id, { id, status: 'running', ...patch });
    return runs.get(id) as AgentRun;
  };

  afterEach(() => {
    runs.clear();
    sending.clear();
    callbacks.activeId = undefined;
    setWatched([]);
    vi.unstubAllGlobals();
  });

  it('отправка < открытый < ждущий человека < ветвь открытого < хвост < прочие', () => {
    sending.add('send');
    callbacks.activeId = 'open';
    setWatched(['child']);
    const ranks = [
      priority('send', put('send')),
      priority('open', put('open')),
      priority('asks', put('asks', { askedQuestion: true })),
      priority('child', put('child')),
      priority('tail', put('tail', { tailOnly: true, status: 'idle' })),
      priority('rest', put('rest')),
    ];
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('открытый разговор узнаётся и по sessionId, и по временному ключу', () => {
    callbacks.activeId = 'sess-1';
    expect(priority('new-1', put('new-1', { sessionId: 'sess-1' }))).toBe(1);
    callbacks.activeId = 'new-1';
    expect(priority('new-1', runs.get('new-1') as AgentRun)).toBe(1);
  });

  it('запрос прав ждёт человека так же, как вопрос', () => {
    const run = put('perm', { permissions: [{ toolUseId: 't', toolName: 'Bash', input: {} }] });
    expect(priority('perm', run)).toBe(2);
  });

  it('бюджет видимой вкладки — MAX_STREAMS, скрытой — ноль', () => {
    expect(budget()).toBe(MAX_STREAMS);
    vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: () => undefined });
    expect(budget()).toBe(0);
  });
});
