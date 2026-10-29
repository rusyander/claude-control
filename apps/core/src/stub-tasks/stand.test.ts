import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChildConfig } from './__fixtures__/e2e/e2e.types.ts';
import { jsonLines, runCore } from './__fixtures__/e2e/stand.ts';

/**
 * Обвязка сквозного прогона сама (F-124): итог и записи — только своего запуска, оборванный
 * хвост журнала не вешает `runCore`, процесс, который не запустился, — отказ, а не таймаут.
 * Процесс ядра подменён (`fake-core-child.mjs`): проверяется обвязка, не ядро.
 */

const FAKE = fileURLToPath(new URL('./__fixtures__/e2e/fake-core-child.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'e2e-stand-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function standFor(name: string): { root: string; cfg: (mode: string) => ChildConfig } {
  const dir = join(root, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  return {
    root: dir,
    cfg: (mode) => ({ home: join(dir, 'home'), request: mode }) as ChildConfig,
  };
}

describe('e2e stand harness (F-124)', () => {
  it('jsonLines: reads from the byte offset, drops an unterminated last line, throws on a broken middle line', () => {
    const file = join(root, 'lines.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":');
    expect(jsonLines(file)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonLines(file, '{"a":1}\n'.length)).toEqual([{ b: 2 }]);
    expect(jsonLines(join(root, 'none.jsonl'))).toEqual([]);
    writeFileSync(file, '{"a":1}\n{"b":\n{"c":3}\n');
    expect(() => jsonLines(file)).toThrow(/line 2 after byte 0 is not JSON/);
  });

  it('a torn last note does not hang runCore; lines written before the run (a torn tail included) are not this run’s', async () => {
    const s = standFor('torn');
    // Прежний запуск стенда убит посреди записи: хвост без перевода строки.
    appendFileSync(join(s.root, 'conduct.jsonl'), '{"pid":1,"event":"old"}\n{"pid":1,"ev');
    const run = await runCore(s, s.cfg('torn-tail'), 30_000, { child: FAKE });
    expect(run.code).toBe(0);
    expect(run.result).toEqual({ outcome: 'ok' });
    expect(run.notes.map((n) => n.event)).toEqual(['boot']);
  });

  it('an unreadable result file rejects with the reason instead of throwing inside the exit handler', async () => {
    const s = standFor('garbage');
    await expect(runCore(s, s.cfg('garbage-result'), 30_000, { child: FAKE })).rejects.toThrow(
      /output is unreadable/,
    );
  });

  it('every run gets its own runId: a later run without a result does not read the earlier run’s result', async () => {
    const s = standFor('reuse');
    const first = await runCore(s, s.cfg('torn-tail'), 30_000, { child: FAKE });
    expect(first.result).toEqual({ outcome: 'ok' });
    const second = await runCore(s, s.cfg('no-result'), 30_000, { child: FAKE });
    expect(second.result).toBeUndefined();
    expect(second.notes).toHaveLength(1);
    expect(second.notes[0]?.runId).not.toBe(first.notes[0]?.runId);
  });

  it('a child that cannot start rejects at once, not at the timeout', async () => {
    const s = standFor('nostart');
    const started = Date.now();
    await expect(
      runCore(s, s.cfg('no-result'), 30_000, { node: join(root, 'no-such-node.exe') }),
    ).rejects.toThrow(/did not start/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
