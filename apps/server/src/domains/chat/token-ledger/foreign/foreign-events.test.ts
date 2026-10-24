import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexEntries, qwenEntries } from '../../../analytics/scanner/foreign.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import { codexWatchEvents, normalizeToolName, qwenWatchEvents } from './foreign-events.ts';

/**
 * Переписки — записи НАСТОЯЩИХ CLI (codex-cli 0.155.1, qwen 0.24.3) на
 * подменной модели во временном доме: два хода, вызов оболочки и чтение,
 * сжатия окна. Пути обезличены (`C:\qa`).
 */
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const lines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
const CODEX = lines('codex-0.155-two-turns.jsonl');
const QWEN = lines('qwen-0.24-two-turns.jsonl');

function events(read: (row: unknown) => WatchEvent[], rows: readonly string[]): WatchEvent[] {
  return rows.flatMap((line) => read(JSON.parse(line)));
}
const kinds = (list: readonly WatchEvent[], kind: WatchEvent['kind']) =>
  list.filter((event) => event.kind === kind);

async function analyticsCalls(
  source: typeof codexEntries,
  rows: readonly string[],
): Promise<number[]> {
  const out: number[] = [];
  async function* feed(): AsyncIterable<string> {
    yield* rows;
  }
  for await (const entry of source(feed())) {
    const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
    if (usage) out.push((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0));
  }
  return out;
}

describe('foreign-events', () => {
  it('codex tool + result + usage', async () => {
    const list = events(codexWatchEvents(), CODEX);
    // Два хода: `task_started` … `task_complete`.
    expect(kinds(list, 'start')).toHaveLength(2);
    expect(kinds(list, 'end')).toHaveLength(2);
    // Вызов модели — `token_usage_record`, ровно по одному на ответ: повторы
    // `token_count` с теми же итогами в вызовы не идут.
    const calls = kinds(list, 'call');
    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatchObject({
      model: 'stub-model',
      input: 5001,
      cacheRead: 4000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 20,
    });
    // Тот же счёт, что у аналитики: карточка и страница аналитики сходятся.
    expect(calls.map((call) => (call.kind === 'call' ? call.input + call.cacheRead : 0))).toEqual(
      await analyticsCalls(codexEntries, CODEX),
    );
    expect(kinds(list, 'tool')[0]).toMatchObject({
      id: 'call_1',
      name: 'Bash',
      input: { command: 'echo hello-tool' },
    });
    const result = kinds(list, 'toolResult')[0];
    expect(result).toMatchObject({ id: 'call_1' });
    expect(result?.kind === 'toolResult' && result.chars).toBeGreaterThan(0);
    expect(kinds(list, 'compact')).toHaveLength(2);
    expect(kinds(list, 'activity').length).toBeGreaterThan(0);
    // Время — из строки, а не часы машины.
    expect(list[0]?.t).toBe(Date.parse('2026-10-22T18:41:33.368Z'));
  });

  it('qwen functionCall/functionResponse', async () => {
    const list = events(qwenWatchEvents(), QWEN);
    expect(kinds(list, 'start')).toHaveLength(2);
    const calls = kinds(list, 'call');
    expect(calls).toHaveLength(7);
    expect(calls.map((call) => (call.kind === 'call' ? call.input + call.cacheRead : 0))).toEqual(
      await analyticsCalls(qwenEntries, QWEN),
    );
    expect(kinds(list, 'tool')).toMatchObject([
      { id: 'call_1', name: 'Bash', input: { command: 'echo hello-tool' } },
      { id: 'call_5', name: 'Read', input: { file_path: 'C:/qa/rec/qcwd/notes.txt' } },
    ]);
    expect(kinds(list, 'toolResult')).toMatchObject([
      { id: 'call_1', chars: expect.any(Number) as number },
      { id: 'call_5', chars: 'hello notes\n'.length },
    ]);
    // `chat_compression` по порогу — буря сжатий видна R3, не «по просьбе».
    expect(kinds(list, 'compact')).toHaveLength(3);
    expect(kinds(list, 'compact').every((event) => !('manual' in event))).toBe(true);
    // Конец хода у Qwen Code шлёт сам прогон: текст ответа — только «жива».
    expect(kinds(list, 'end')).toHaveLength(0);
    expect(kinds(list, 'activity')).toHaveLength(2);
  });

  it('a repeated row (re-read after a rewrite) does not count its call twice', () => {
    const codex = codexWatchEvents();
    const record = CODEX.find((line) => line.includes('"token_usage_record"'))!;
    expect(codex(JSON.parse(record))).toHaveLength(1);
    expect(codex(JSON.parse(record))).toHaveLength(0);
    const qwen = qwenWatchEvents();
    const telemetry = QWEN.find((line) => line.includes('qwen-code.api_response'))!;
    expect(qwen(JSON.parse(telemetry))).toHaveLength(1);
    expect(qwen(JSON.parse(telemetry))).toHaveLength(0);
  });

  it('names normalized to Bash/Read/Edit', () => {
    expect(
      normalizeToolName('codex', 'exec_command', { cmd: 'pnpm test', timeout_ms: 5000 }),
    ).toEqual({ name: 'Bash', input: { command: 'pnpm test', timeout: 5000 } });
    expect(normalizeToolName('codex', 'shell', { command: ['git', 'status'] })).toEqual({
      name: 'Bash',
      input: { command: 'git status' },
    });
    expect(
      normalizeToolName('codex', 'apply_patch', {
        input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch',
      }),
    ).toEqual({ name: 'Edit', input: { file_path: 'src/a.ts' } });
    expect(normalizeToolName('codex', 'read_file', { file_path: 'a.ts' })).toEqual({
      name: 'Read',
      input: { file_path: 'a.ts' },
    });
    expect(
      normalizeToolName('qwen', 'run_shell_command', {
        command: 'npm run dev',
        is_background: true,
      }),
    ).toEqual({ name: 'Bash', input: { command: 'npm run dev', run_in_background: true } });
    expect(normalizeToolName('qwen', 'read_file', { absolute_path: '/w/a.ts' })).toEqual({
      name: 'Read',
      input: { file_path: '/w/a.ts' },
    });
    expect(normalizeToolName('qwen', 'read_many_files', { paths: ['a.ts'] })).toEqual({
      name: 'Read',
      input: { file_path: 'a.ts' },
    });
    expect(normalizeToolName('qwen', 'read_many_files', { paths: ['a.ts', 'b.ts'] })).toEqual({
      name: 'Read',
      input: {},
    });
    expect(normalizeToolName('qwen', 'edit', { file_path: '/w/a.ts' })).toEqual({
      name: 'Edit',
      input: { file_path: '/w/a.ts' },
    });
    expect(normalizeToolName('qwen', 'write_file', { file_path: '/w/b.ts' })).toEqual({
      name: 'Edit',
      input: { file_path: '/w/b.ts' },
    });
    // Незнакомое имя — как есть.
    expect(normalizeToolName('qwen', 'web_fetch', { url: 'x' })).toEqual({
      name: 'web_fetch',
      input: { url: 'x' },
    });
  });
});
