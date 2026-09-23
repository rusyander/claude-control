import { describe, it, expect } from 'vitest';
import { buildProgress } from './ChatProgress.ts';
import type { TranscriptRecord } from './ChatHistory.ts';

/**
 * Фон и текущий вызов в прогрессе. Тексты расписок и уведомлений — дословно те,
 * что CLI записал в живой разговор 23.09.2026, где обе фоновые команды умерли с
 * концом хода, а человек двадцать минут не знал, идёт ли работа.
 */

const at = (minute: number) => `2026-09-23T07:${String(minute).padStart(2, '0')}:00.000Z`;

function assistant(minute: number, blocks: unknown[]): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: at(minute),
    message: { content: blocks },
  } as TranscriptRecord;
}

function user(minute: number, content: unknown): TranscriptRecord {
  return { type: 'user', timestamp: at(minute), message: { content } } as TranscriptRecord;
}

const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  name: 'Bash',
  id,
  input: { command, description: 'Install deps', ...extra },
});

const result = (id: string, text: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: text,
});

const notification = (task: string, status: string) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>x</tool-use-id>\n<status>${status}</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>`;

describe('buildProgress — фон и текущий вызов', () => {
  it('команда, уведённая в фон по таймауту, видна фоновой, хотя фон не просили', () => {
    const progress = buildProgress([
      assistant(15, [bash('u1', 'node scripts/frontend_install.mjs 2>&1 | tail -8')]),
      user(25, [
        result(
          'u1',
          'Command did not complete within its 600s timeout and was moved to the background (ID: bxkhy3tpp). Output is being written to: C:\\tmp\\x.output',
        ),
      ]),
    ]);

    expect(progress.shells).toEqual([
      {
        id: 'u1',
        command: 'node scripts/frontend_install.mjs 2>&1 | tail -8',
        startedAt: at(15),
        status: 'running',
      },
    ]);
  });

  it('run_in_background закрывается уведомлением: stopped — оборвана концом процесса', () => {
    const progress = buildProgress([
      assistant(39, [
        bash('u2', 'node scripts/check_frontend.mjs --all', { run_in_background: true }),
      ]),
      user(39, [
        result(
          'u2',
          'Command running in background with ID: b0moxbbvx. Output is being written to: x',
        ),
      ]),
      user(52, notification('b0moxbbvx', 'stopped')),
    ]);

    expect(progress.shells?.map((shell) => shell.status)).toEqual(['stopped']);
  });

  it('completed — готово, failed — упала', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm test', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t1.')]),
      assistant(2, [bash('b', 'pnpm lint', { run_in_background: true })]),
      user(2, [result('b', 'Command running in background with ID: t2.')]),
      user(3, [{ type: 'text', text: notification('t1', 'completed') }]),
      user(4, notification('t2', 'failed')),
    ]);

    expect(progress.shells?.map((shell) => [shell.id, shell.status])).toEqual([
      ['a', 'done'],
      ['b', 'failed'],
    ]);
  });

  it('уведомление, процитированное агентом, статус не меняет', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm test', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t1.')]),
      assistant(2, [{ type: 'text', text: notification('t1', 'completed') }]),
    ]);

    expect(progress.shells?.[0]?.status).toBe('running');
  });

  it('вызов без результата — текущий, с описанием и временем старта', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm install')]),
      user(2, [result('a', 'ok')]),
      assistant(3, [bash('b', 'pnpm test', { description: 'Wait for tests' })]),
    ]);

    expect(progress.activeTool).toEqual({
      name: 'Bash',
      summary: 'Wait for tests',
      startedAt: at(3),
    });
    expect(progress.shells).toBeUndefined();
  });

  it('все вызовы вернулись — текущего нет', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm install')]),
      user(2, [result('a', 'ok')]),
    ]);

    expect(progress.activeTool).toBeUndefined();
  });
});
