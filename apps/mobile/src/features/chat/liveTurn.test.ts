import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import type { StreamedTool } from '../../shared/lib/runs/types';
import { liveToolsOutsideHistory } from './liveTurn';

const START = Date.parse('2026-09-28T09:00:00.000Z');
const ASK_INPUT = JSON.stringify({ questions: [{ question: 'Which stack?' }] });
const TASK_INPUT = JSON.stringify({ description: 'Scan the repo' });

function assistant(id: string, at: string, tools: [string, string][]): ChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: at,
    blocks: tools.map(([name, input]) => ({ type: 'tool' as const, name, input })),
  };
}

const live: StreamedTool[] = [
  { name: 'AskUserQuestion', input: ASK_INPUT, id: 'toolu_ask' },
  { name: 'Agent', input: TASK_INPUT, id: 'toolu_task' },
];

describe('liveToolsOutsideHistory', () => {
  it('чат открыт посреди хода: вызовы, уже записанные в транскрипт, из потока убраны', () => {
    const history = [
      assistant('a1', '2026-09-28T09:00:01.000Z', [['AskUserQuestion', ASK_INPUT]]),
      assistant('a2', '2026-09-28T09:00:02.000Z', [['Agent', TASK_INPUT]]),
    ];
    expect(liveToolsOutsideHistory(history, live, START)).toEqual([]);
  });

  it('вызов, которого в транскрипте ещё нет, остаётся в потоке', () => {
    const history = [assistant('a1', '2026-09-28T09:00:01.000Z', [['AskUserQuestion', ASK_INPUT]])];
    expect(liveToolsOutsideHistory(history, live, START)).toEqual([live[1]]);
  });

  it('тот же вызов из прошлого хода (до старта) не гасит вызов этого хода', () => {
    const history = [
      assistant('old', '2026-09-28T08:59:59.999Z', [['AskUserQuestion', ASK_INPUT]]),
    ];
    expect(liveToolsOutsideHistory(history, live, START)).toBe(live);
  });

  it('одна запись гасит один вызов: два одинаковых вызова в потоке — один остаётся', () => {
    const twice: StreamedTool[] = [
      { name: 'Read', input: '{"file":"a"}' },
      { name: 'Read', input: '{"file":"a"}' },
    ];
    const history = [assistant('a1', '2026-09-28T09:00:01.000Z', [['Read', '{"file":"a"}']])];
    expect(liveToolsOutsideHistory(history, twice, START)).toEqual([twice[1]]);
  });

  it('без серверного старта — поток как есть; реплика человека не в счёт', () => {
    const history = [assistant('a1', '2026-09-28T09:00:01.000Z', [['AskUserQuestion', ASK_INPUT]])];
    expect(liveToolsOutsideHistory(history, live, undefined)).toBe(live);
    const human: ChatMessage = { ...history[0]!, role: 'user' };
    expect(liveToolsOutsideHistory([human], live, START)).toBe(live);
  });
});
