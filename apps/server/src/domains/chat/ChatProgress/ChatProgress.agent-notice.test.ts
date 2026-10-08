import { describe, it, expect } from 'vitest';
import { buildProgress } from './ChatProgress.ts';
import type { TranscriptRecord } from '../ChatHistory/ChatHistory.ts';

/**
 * Фоновый субагент (claude 2.1.282, замер 28.09 стабом модели): вызов `Agent`
 * отвечает распиской «Async agent launched…», а итог приходит позже репликой
 * `<task-notification>` от имени человека, где `<tool-use-id>` — id того
 * вызова. Прогресс ждал итога только в результате вызова и держал субагента
 * «работающим» вечно — ни панель, ни телефон не видели, что он закончил (1b).
 */

const at = (minute: number) => `2026-09-28T07:${String(minute).padStart(2, '0')}:00.000Z`;

const assistant = (minute: number, blocks: unknown[]): TranscriptRecord =>
  ({ type: 'assistant', timestamp: at(minute), message: { content: blocks } }) as TranscriptRecord;

const user = (minute: number, content: unknown): TranscriptRecord =>
  ({ type: 'user', timestamp: at(minute), message: { content } }) as TranscriptRecord;

const agent = (id: string, description: string) => ({
  type: 'tool_use',
  name: 'Agent',
  id,
  input: { description, prompt: 'scan', subagent_type: 'Explore', run_in_background: true },
});

const launched = (id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [
    {
      type: 'text',
      text: 'Async agent launched successfully. (This tool result is not the agent output.)\nagentId: a4da67',
    },
  ],
});

const notice = (id: string, status: string, summary = `Agent "Scan" ${status}`) =>
  `<task-notification>\n<task-id>a4da67</task-id>\n<tool-use-id>${id}</tool-use-id>\n` +
  `<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

describe('buildProgress — итог фонового субагента из уведомления', () => {
  it('до уведомления субагент работает, после — готов', () => {
    const records = [
      assistant(1, [agent('toolu_a', 'Scan the repo')]),
      user(1, [launched('toolu_a')]),
    ];
    expect(buildProgress(records).agents.map((item) => item.status)).toEqual(['running']);
    const done = buildProgress([...records, user(5, notice('toolu_a', 'completed'))]);
    expect(done.agents).toMatchObject([{ id: 'toolu_a', status: 'done' }]);
  });

  it('упавший и остановленный — «failed», чужой id ничего не трогает', () => {
    const progress = buildProgress([
      assistant(1, [agent('toolu_a', 'A'), agent('toolu_b', 'B'), agent('toolu_c', 'C')]),
      user(1, [launched('toolu_a'), launched('toolu_b'), launched('toolu_c')]),
      user(3, notice('toolu_a', 'failed')),
      user(4, [{ type: 'text', text: notice('toolu_b', 'killed') }]),
      user(5, notice('toolu_zzz', 'completed')),
    ]);
    expect(progress.agents.map((item) => item.status)).toEqual(['failed', 'failed', 'running']);
  });

  it('несколько уведомлений одной репликой закрывают каждое своё', () => {
    const progress = buildProgress([
      assistant(1, [agent('toolu_a', 'A'), agent('toolu_b', 'B')]),
      user(1, [launched('toolu_a'), launched('toolu_b')]),
      user(3, `${notice('toolu_a', 'completed')}\n${notice('toolu_b', 'completed')}`),
    ]);
    expect(progress.agents.map((item) => item.status)).toEqual(['done', 'done']);
  });
});
