import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import {
  callTranscriptFile,
  recordedToolCallCwd,
  settledToolCallCwd,
  toolCallCwd,
} from './tool-call-cwd.ts';

/**
 * Вызов субагента (26.10): CLI пишет его в `<сессия>/subagents/agent-*.jsonl`, а
 * искали его только в файле разговора — каждый запрос прав субагента ждал 1,3 с и
 * судился от угаданного корня копии. Настоящие файлы в каталоге проектов.
 */
const ROOT = 'C:\\work\\copy';
const SUB = 'C:\\work\\copy\\inst-admin-ui';

const call = (id: string, cwd: string, sidechain: boolean): Record => ({
  type: 'assistant',
  cwd,
  ...(sidechain ? { isSidechain: true } : {}),
  message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash' }] },
});
const lines = (records: Record[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function projects(subagents: number): { dir: string; main: string; sub: (n: number) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-call-sub-'));
  made.push(dir);
  mkdirSync(join(dir, 'C--work-copy', 'sess-1', 'subagents'), { recursive: true });
  const main = join(dir, 'C--work-copy', 'sess-1.jsonl');
  writeFileSync(main, lines([call('main-1', ROOT, false)]));
  const sub = (n: number): string =>
    join(dir, 'C--work-copy', 'sess-1', 'subagents', `agent-${n}.jsonl`);
  for (let n = 0; n < subagents; n += 1) {
    writeFileSync(sub(n), lines([call(`sub-${n}`, SUB, true)]));
    // Старшие номера — свежее: файл 0 правился раньше всех.
    const at = new Date(Date.now() - (subagents - n) * 60_000);
    utimesSync(sub(n), at, at);
  }
  return { dir, main, sub };
}

describe('вызов субагента — в его файле', () => {
  it('каталог из записи субагента, сразу и без ожидания', async () => {
    const { dir } = projects(2);
    expect(toolCallCwd(dir, 'sess-1', 'sub-1')).toBe(SUB);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    expect(await settledToolCallCwd(dir, 'sess-1', 'sub-0', { sleep })).toBe(SUB);
    expect(slept).toEqual([]);
    expect(toolCallCwd(dir, 'sess-1', 'main-1')).toBe(ROOT);
  });

  it('`callTranscriptFile` — файл, где лежит вызов: разговор или субагент', () => {
    const { dir, main, sub } = projects(2);
    expect(callTranscriptFile(dir, 'sess-1', 'sub-1')).toBe(sub(1));
    expect(callTranscriptFile(dir, 'sess-1', 'main-1')).toBe(main);
    expect(callTranscriptFile(dir, 'sess-1', 'missing')).toBeUndefined();
    expect(callTranscriptFile(dir, '../sess-1', 'sub-1')).toBeUndefined();
    expect(callTranscriptFile(dir, 'sess-1', undefined)).toBeUndefined();
  });

  it('живой запрос смотрит свежайшие файлы; пересуд — все', () => {
    const { dir, sub } = projects(8);
    // Файл 0 — старше шести свежайших: хвостом не найти, целиком — да.
    expect(toolCallCwd(dir, 'sess-1', 'sub-0')).toBeUndefined();
    expect(recordedToolCallCwd(dir, 'sess-1', 'sub-0')).toBe(SUB);
    expect(callTranscriptFile(dir, 'sess-1', 'sub-0')).toBe(sub(0));
    expect(toolCallCwd(dir, 'sess-1', 'sub-7')).toBe(SUB);
  });

  it('запись не субагента в его файле и субагента в файле разговора — не в счёт', () => {
    const { dir, main, sub } = projects(0);
    writeFileSync(sub(0), lines([call('odd-1', SUB, false)]));
    writeFileSync(main, lines([call('odd-2', SUB, true)]));
    expect(toolCallCwd(dir, 'sess-1', 'odd-1')).toBeUndefined();
    expect(recordedToolCallCwd(dir, 'sess-1', 'odd-2')).toBeUndefined();
    expect(callTranscriptFile(dir, 'sess-1', 'odd-1')).toBeUndefined();
  });
});
