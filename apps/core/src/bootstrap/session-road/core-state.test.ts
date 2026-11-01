import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readSessionState, SNAPSHOT_SIGNAL, writeSessionState } from './core-state.ts';

/**
 * Снимок ядра о сессии (P90, P04): запись кладёт файл в дом ядра и сигнал `session-snapshot` с
 * отпечатком в журнал задачи; чтение верит файлу только при совпавшем отпечатке. Подменённый,
 * пропавший или неучтённый файл — `unknown` с причиной, а не значение.
 */

describe('core session snapshots', () => {
  it('session-snapshot: writing a snapshot journals an info signal with its sha256 digest, and the read returns the value', async () => {
    const { task } = await openFresh();
    const root = tempDir('core-state-');
    const sessionId = newId();
    writeSessionState(task, root, sessionId, 'resources.json', { engine: 'git', n: 1 });
    const rows = readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === 'signal');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.data).toEqual({
      signal: SNAPSHOT_SIGNAL,
      severity: 'info',
      subject: 'resources.json',
      detail: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(readSessionState(task, root, sessionId, 'resources.json')).toEqual({
      value: { engine: 'git', n: 1 },
    });
    task.close();
  });

  it('a snapshot rewritten after the core wrote it, removed, or never journaled reads as unknown; no file and no digest is absent', async () => {
    const { task } = await openFresh();
    const root = tempDir('core-state-');
    const sessionId = newId();
    const file = join(root, sessionId, 'roots.json');
    writeSessionState(task, root, sessionId, 'roots.json', { roots: ['a'] });
    writeFileSync(file, JSON.stringify({ roots: [] }));
    expect(readSessionState(task, root, sessionId, 'roots.json')).toEqual({
      unknown: 'roots.json: changed after the core wrote it',
    });
    rmSync(file);
    expect(readSessionState(task, root, sessionId, 'roots.json')).toEqual({
      unknown: 'roots.json: written by the core, now missing',
    });
    // Другая сессия: файл положил не ядро — отпечатка нет.
    const other = newId();
    expect(readSessionState(task, root, other, 'roots.json')).toEqual({ absent: true });
    writeSessionState(task, tempDir('elsewhere-'), other, 'x.json', {});
    writeFileSync(join(root, sessionId, 'planted.json'), '{}');
    expect(readSessionState(task, root, sessionId, 'planted.json')).toEqual({
      unknown: 'planted.json: no digest in the task journal',
    });
    task.close();
  });
});
