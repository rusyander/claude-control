import { describe, expect, it } from 'vitest';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { EMPTY_RUN, type AgentRun, type StreamedTool } from '../../shared/lib/runs/types';
import { inboxChatNamed, liveQuestionAsks, parseQuestions, withLiveAsks } from './liveAsks';

/**
 * Сводка сервера теряет вопрос, как только CLI пишет итог фонового субагента
 * репликой «от человека» (живой прогон 28.09, 1b). Телефон держит поток хода и
 * берёт вопрос оттуда — тем же ключом, что сервер, чтобы не удвоить.
 */

const QUESTIONS = {
  questions: [
    {
      question: 'Which stack?',
      header: 'Stack',
      options: [{ label: 'Node', description: 'fast' }, { label: 'Go' }, { label: '' }],
    },
    { question: '  ' },
  ],
};

const askTool = (id: string, over: Partial<StreamedTool> = {}): StreamedTool => ({
  name: 'AskUserQuestion',
  input: JSON.stringify(QUESTIONS),
  id,
  at: Date.parse('2026-09-28T07:00:00.000Z'),
  ...over,
});

const run = (over: Partial<AgentRun>): AgentRun => ({
  ...EMPTY_RUN,
  id: 'new-1',
  status: 'running',
  sessionId: 'sess-1',
  ...over,
});

const chat = (over: Partial<InboxChat> = {}): InboxChat => ({
  id: 'sess-1',
  runKey: 'new-1',
  sessionId: 'sess-1',
  title: 't',
  project: 'p',
  projectPath: 'C:/p',
  isSandbox: false,
  status: 'idle',
  running: true,
  updatedAt: '2026-09-28T06:00:00.000Z',
  asks: [],
  ...over,
});

describe('parseQuestions', () => {
  it('берёт только похожее на вопрос, пустые варианты отбрасывает', () => {
    expect(parseQuestions(JSON.stringify(QUESTIONS))).toEqual([
      {
        question: 'Which stack?',
        header: 'Stack',
        options: [{ label: 'Node', description: 'fast' }, { label: 'Go' }],
      },
    ]);
    expect(parseQuestions('not json')).toEqual([]);
    expect(parseQuestions('{"questions":3}')).toEqual([]);
  });
});

describe('liveQuestionAsks', () => {
  it('открытый вопрос идущего хода — с ключом сервера', () => {
    const asks = liveQuestionAsks(run({ tools: [askTool('toolu_1')] }));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: 'question',
      key: 'q:toolu_1:0',
      toolUseId: 'toolu_1',
      index: 0,
      total: 1,
      askedAt: '2026-09-28T07:00:00.000Z',
    });
  });

  it('закрытый автовыбором, законченный ход и хвост — без вопросов', () => {
    expect(liveQuestionAsks(run({ tools: [askTool('t', { autoPicks: [] })] }))).toEqual([]);
    expect(liveQuestionAsks(run({ status: 'done', tools: [askTool('t')] }))).toEqual([]);
    expect(liveQuestionAsks(run({ tailOnly: true, tools: [askTool('t')] }))).toEqual([]);
    expect(liveQuestionAsks(run({ tools: [{ name: 'Bash', input: '{}', id: 'b' }] }))).toEqual([]);
  });
});

describe('withLiveAsks', () => {
  it('сервер вопрос потерял — строка получает его из потока и статус «ждёт»', () => {
    const [row] = withLiveAsks([chat()], [run({ tools: [askTool('toolu_1')] })]);
    expect(row?.status).toBe('waiting');
    expect(row?.asks.map((ask) => ask.key)).toEqual(['q:toolu_1:0']);
    expect(row?.updatedAt).toBe('2026-09-28T07:00:00.000Z');
  });

  it('сервер вопрос знает — не удваивается, строка та же', () => {
    const known = chat({
      status: 'waiting',
      asks: liveQuestionAsks(run({ tools: [askTool('toolu_1')] })),
    });
    const [row] = withLiveAsks([known], [run({ tools: [askTool('toolu_1')] })]);
    expect(row).toBe(known);
  });

  it('чат без своего прогона не трогается', () => {
    const other = chat({ id: 'sess-2', runKey: undefined, sessionId: 'sess-2' });
    expect(withLiveAsks([other], [run({ tools: [askTool('toolu_1')] })])[0]).toBe(other);
  });
});

describe('inboxChatNamed', () => {
  it('находит строку по ключу прогона, сессии или id', () => {
    const row = chat();
    expect(inboxChatNamed([row], 'new-1')).toBe(row);
    expect(inboxChatNamed([row], undefined, 'sess-1')).toBe(row);
    expect(inboxChatNamed([row], 'other')).toBeUndefined();
  });
});
