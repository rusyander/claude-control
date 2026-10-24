import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import { callCwdIn, toolCallCwd } from './tool-call-cwd.ts';

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
