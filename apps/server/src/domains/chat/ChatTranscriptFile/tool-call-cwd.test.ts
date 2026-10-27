import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import {
  callCwdIn,
  recordedToolCallCwd,
  sessionTranscriptFile,
  settledToolCallCwd,
  toolCallCwd,
} from './tool-call-cwd.ts';

/** Каталог оболочки CLI для вызова инструмента — по записям транскрипта (N4, 23.10). */
const ROOT = 'C:\\work\\copy';
const SUB = 'C:\\work\\copy\\inst-docs-ui';

const call = (id: string, cwd: string, turn = 'msg_1'): Record => ({
  type: 'assistant',
  cwd,
  message: { id: turn, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash' }] },
});
const result = (id: string, cwd: string): Record => ({
  type: 'user',
  cwd,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] },
});

describe('callCwdIn', () => {
  it('каталог записи вызова — после `cd` прошлой командой', () => {
    const records = [call('t1', ROOT, 'm1'), result('t1', SUB), call('t2', SUB, 'm2')];
    expect(callCwdIn(records, 't2')).toBe(SUB);
  });

  it('соседний вызов того же ответа исполнен раньше — каталог после него', () => {
    const records = [call('t1', SUB), call('t2', SUB), result('t1', ROOT)];
    expect(callCwdIn(records, 't2')).toBe(ROOT);
  });

  it('соседний вызов раньше ещё без результата — каталог неизвестен', () => {
    // `cd ..` первым вызовом и `rm -rf ../src` вторым: по записи — подпроект, а оболочка уже в корне.
    expect(callCwdIn([call('t1', SUB), call('t2', SUB)], 't2')).toBeUndefined();
  });

  it('записи субагента не в счёт; вызова нет — неизвестен', () => {
    const records = [call('t1', SUB), { ...result('x', 'C:\\elsewhere'), isSidechain: true }];
    expect(callCwdIn(records, 't1')).toBe(SUB);
    expect(callCwdIn(records, 'missing')).toBeUndefined();
    expect(callCwdIn([{ ...call('t1', SUB), isSidechain: true }], 't1')).toBeUndefined();
  });
});

describe('toolCallCwd — файл разговора', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it('находит разговор в каталоге проектов и читает хвост', () => {
    const projects = mkdtempSync(join(tmpdir(), 'cc-call-cwd-'));
    made.push(projects);
    mkdirSync(join(projects, 'C--work-copy'));
    const lines = [call('t1', ROOT, 'm1'), result('t1', SUB), call('t2', SUB, 'm2')];
    writeFileSync(
      join(projects, 'C--work-copy', 'sess-1.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    expect(toolCallCwd(projects, 'sess-1', 't2')).toBe(SUB);
    expect(toolCallCwd(projects, 'sess-2', 't2')).toBeUndefined();
    expect(toolCallCwd(projects, '../sess-1', 't2')).toBeUndefined();
    expect(toolCallCwd(projects, 'sess-1', undefined)).toBeUndefined();
  });
});

/**
 * Запись вызова ещё не в файле (D-6, 25.10): запрос прав пришёл за полсекунды до
 * того, как CLI дописал транскрипт, и `..` судился от корня копии. Чтение
 * повторяется короткими шагами в пределе ~1,3 с; соседний вызов без результата
 * не ждут — его запись ляжет только после исполнения.
 */
describe('settledToolCallCwd — запись вызова дописывается', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  function transcript(lines: Record[]): string {
    const projects = mkdtempSync(join(tmpdir(), 'cc-call-wait-'));
    made.push(projects);
    mkdirSync(join(projects, 'C--work-copy'));
    const file = join(projects, 'C--work-copy', 'sess-1.jsonl');
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return projects;
  }

  it('вызова ещё нет — повтор, пока запись не легла; каталог из неё', async () => {
    const projects = transcript([call('t1', ROOT, 'm1'), result('t1', SUB)]);
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 2) {
        const line = JSON.stringify(call('t2', SUB, 'm2'));
        writeFileSync(join(projects, 'C--work-copy', 'sess-1.jsonl'), `${line}\n`, { flag: 'a' });
      }
    };
    expect(await settledToolCallCwd(projects, 'sess-1', 't2', { sleep })).toBe(SUB);
    expect(slept).toHaveLength(2);
  });

  it('вызов так и не лёг — предел ожидания до полутора секунд, затем неизвестен', async () => {
    const projects = transcript([call('t1', ROOT, 'm1')]);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    expect(await settledToolCallCwd(projects, 'sess-1', 'never', { sleep })).toBeUndefined();
    const total = slept.reduce((sum, ms) => sum + ms, 0);
    expect(slept.length).toBeGreaterThan(2);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(total).toBeLessThanOrEqual(1500);
    expect(Math.max(...slept)).toBeLessThanOrEqual(300);
  });

  it('соседний вызов без результата, вызов найден, разговора нет — без ожидания', async () => {
    const projects = transcript([call('t1', SUB), call('t2', SUB), call('t3', ROOT, 'm3')]);
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    expect(await settledToolCallCwd(projects, 'sess-1', 't2', { sleep })).toBeUndefined();
    expect(await settledToolCallCwd(projects, 'sess-1', 't3', { sleep })).toBe(ROOT);
    expect(await settledToolCallCwd(projects, 'sess-9', 't3', { sleep })).toBeUndefined();
    expect(await settledToolCallCwd(projects, 'sess-1', undefined, { sleep })).toBeUndefined();
    expect(slept).toEqual([]);
  });
});

/**
 * Пересуд после перезапуска (D-9, 25.10): запрос ждал часами. Запись вызова ушла
 * из хвоста 512 КБ — каталог не находился; и `cd` группы после вызова сдвигал его
 * каталог. Предел — результат этого вызова; нет вызова в хвосте — файл целиком.
 */
describe('recordedToolCallCwd — пересуд ждущей записи', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it('`cd` после результата этого вызова каталог вызова не сдвигает', () => {
    const records = [call('t1', ROOT, 'm1'), result('t1', ROOT), call('t2', SUB, 'm2')];
    expect(callCwdIn(records, 't1')).toBe(ROOT);
  });

  it('вызов дальше хвоста 512 КБ — найден чтением файла целиком', () => {
    const projects = mkdtempSync(join(tmpdir(), 'cc-call-cwd-'));
    made.push(projects);
    mkdirSync(join(projects, 'C--work-copy'));
    const filler = (index: number): Record => ({
      type: 'user',
      cwd: SUB,
      message: { role: 'user', content: `${'x'.repeat(100_000)} ${index}` },
    });
    const lines = [
      call('t1', ROOT, 'm1'),
      result('t1', ROOT),
      ...Array.from({ length: 8 }, (_, index) => filler(index)),
    ];
    writeFileSync(
      join(projects, 'C--work-copy', 'sess-1.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    expect(toolCallCwd(projects, 'sess-1', 't1')).toBeUndefined();
    expect(recordedToolCallCwd(projects, 'sess-1', 't1')).toBe(ROOT);
    expect(recordedToolCallCwd(projects, 'sess-1', 'missing')).toBeUndefined();
    expect(recordedToolCallCwd(projects, 'sess-2', 't1')).toBeUndefined();
    expect(sessionTranscriptFile(projects, 'sess-1')).toBe(
      join(projects, 'C--work-copy', 'sess-1.jsonl'),
    );
    expect(sessionTranscriptFile(projects, '../sess-1')).toBeUndefined();
  });
});
