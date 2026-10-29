import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATED, deps, tempDir } from './__fixtures__/journal-harness.ts';
import { readJournalLines } from './read-lines.ts';
import { createTask, resume } from './resume.ts';
import { TASK_FILES } from './journal.types.ts';

/**
 * Ревью core-s2 F-101 (verify-api V6): `task.created`, отвергнутый писателем, оставлял открытую
 * задачу без хозяина — аренду, удары и дескриптор журнала; после `core.stop()` то же ядро
 * получало `held` на свою же задачу.
 */
describe('core-s2 createTask rollback', () => {
  it('F-101 a rejected task.created releases the lease, stops the beats and closes the writer', async () => {
    const root = tempDir('ct-');
    const d = deps({ beats: true });
    await expect(createTask(root, { ...CREATED, title: 'x'.repeat(100_000) }, d)).rejects.toThrow();
    const [taskId] = readdirSync(root);
    if (!taskId) throw new Error('no task dir');
    const dir = join(root, taskId);
    expect(existsSync(join(dir, TASK_FILES.owner))).toBe(false);
    const beats = statSync(join(dir, TASK_FILES.beats)).size;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(statSync(join(dir, TASK_FILES.beats)).size).toBe(beats);
    const kinds = readJournalLines(dir, taskId).lines.map((l) => l.kind);
    expect(kinds).toEqual(['lease.acquired', 'lease.released']);
    // Тот же процесс открывает задачу снова — не `held`.
    const again = await resume(dir, taskId, deps());
    expect(again.ok).toBe(true);
    if (again.ok) again.task.close();
  }, 30_000);
});
