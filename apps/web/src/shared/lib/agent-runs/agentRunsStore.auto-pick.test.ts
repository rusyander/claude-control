import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { applyEvent } from './agent-runs.events';
import type { AgentRun } from './agent-runs.types';
import { isOpenAsk } from '../chat-stream';
import { runs } from './agent-runs.state.constants';

/**
 * Вопрос агента, закрытый автономией чата. Сервер считает его закрытым по
 * метке в результате вызова, как бы ни разобрался выбор (`chat-inbox.ts`,
 * `ChatRunRegistry`); клиент обязан думать так же. Ревью 28.09 (F-132): при
 * `picks: []` (прогон не видел самого вызова, текст не разобрался) вкладка
 * держала карточку с кнопками и жёлтую точку на вопросе, который сервер уже снял.
 */
const ASK = {
  kind: 'tool',
  name: 'AskUserQuestion',
  input: { questions: [] },
  id: 'X',
} as const;

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

describe('автовыбор закрывает вопрос во вкладке', () => {
  afterEach(() => runs.clear());

  it('выбор разобран — точка гаснет, на вызове строка выбора', () => {
    seed('a');
    applyEvent('a', ASK);
    expect(runs.get('a')?.askedQuestion).toBe(true);
    applyEvent('a', {
      kind: 'autoPick',
      toolUseId: 'X',
      picks: [{ question: 'Q', label: 'A (Recommended)', critical: false }],
    });
    expect(runs.get('a')?.askedQuestion).toBe(false);
    expect(runs.get('a')?.tools[0]?.autoPicks).toEqual([
      { question: 'Q', label: 'A (Recommended)' },
    ]);
  });

  it('выбор не разобрался (`picks: []`) — вопрос всё равно закрыт', () => {
    seed('b');
    applyEvent('b', ASK);
    applyEvent('b', { kind: 'autoPick', toolUseId: 'X', picks: [] });
    expect(runs.get('b')?.askedQuestion).toBe(false);
  });

  it('второй, не закрытый вопрос хода по-прежнему ждёт человека', () => {
    seed('c');
    applyEvent('c', ASK);
    applyEvent('c', { ...ASK, id: 'Y' });
    applyEvent('c', { kind: 'autoPick', toolUseId: 'X', picks: [] });
    expect(runs.get('c')?.askedQuestion).toBe(true);
  });

  it('isOpenAsk: закрыт по самому факту автовыбора, а не по числу выборов', () => {
    expect(isOpenAsk({ name: 'AskUserQuestion' })).toBe(true);
    expect(isOpenAsk({ name: 'AskUserQuestion', autoPicks: [] })).toBe(false);
    expect(isOpenAsk({ name: 'AskUserQuestion', autoPicks: [{}] })).toBe(false);
    expect(isOpenAsk({ name: 'Read' })).toBe(false);
  });
});
