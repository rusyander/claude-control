import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { fakeClock, tempDir } from './__fixtures__/journal-harness.ts';
import { holdFile } from './__fixtures__/hold-file.ts';
import { BACKUPS_KEPT, runDailyBackup } from './backup.ts';
import { genesisHash } from './line.ts';
import { readJournalLines } from './read-lines.ts';
import { openWriter } from './writer.ts';
import { NO_MASK, TASK_FILES } from './journal.types.ts';

const DAY_MS = 24 * 60 * 60_000;

function layout() {
  const root = tempDir('bk-');
  const tasksDir = join(root, 'tasks');
  const profilesDir = join(root, 'profiles');
  const backupsDir = join(root, 'backups');
  mkdirSync(join(tasksDir, 't1'), { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(join(tasksDir, 't1', TASK_FILES.journal), '{"seq":1}\n');
  writeFileSync(join(profilesDir, 'p.json'), '{}');
  return { tasksDir, profilesDir, backupsDir };
}

describe('daily backup', () => {
  it('P74 backups rotate at 7: ten days of runs leave the last seven complete days', () => {
    const dirs = layout();
    // День копии — местный (ревью F-102): моменты задаются местным временем.
    const start = new Date(2026, 9, 1, 12).getTime();
    for (let d = 0; d < 10; d += 1) {
      const out = runDailyBackup({ ...dirs, activeTaskIds: ['t1'], at: start + d * DAY_MS });
      expect(out.failures).toEqual([]);
      expect(out.copied).toBe(2);
    }
    const days = readdirSync(dirs.backupsDir).sort();
    expect(days).toHaveLength(BACKUPS_KEPT);
    expect(days[0]).toBe('2026-10-04');
    expect(days.at(-1)).toBe('2026-10-10');
    expect(
      readFileSync(join(dirs.backupsDir, '2026-10-10', 'tasks', 't1', TASK_FILES.journal), 'utf8'),
    ).toBe('{"seq":1}\n');
  });

  it('s10 G11: chat attachment copies of an active task (outside the core home) ride the day beside its journal; a task without them is no failure', () => {
    const dirs = layout();
    const attachmentsDir = join(dirs.tasksDir, '..', 'agentdeck-attachments');
    mkdirSync(join(attachmentsDir, 't1', 'c1'), { recursive: true });
    writeFileSync(join(attachmentsDir, 't1', 'c1', 'shot.png'), 'png-bytes');
    mkdirSync(join(attachmentsDir, 'gone', 'c1'), { recursive: true });
    writeFileSync(join(attachmentsDir, 'gone', 'c1', 'old.png'), 'x');
    const at = new Date(2026, 9, 23, 9).getTime();
    const out = runDailyBackup({ ...dirs, attachmentsDir, activeTaskIds: ['t1', 'no-files'], at });
    expect(out.failures).toEqual([]);
    expect(out.copied).toBe(3);
    const day = join(dirs.backupsDir, '2026-10-23');
    expect(readFileSync(join(day, 'attachments', 't1', 'c1', 'shot.png'), 'utf8')).toBe(
      'png-bytes',
    );
    // Неактивная задача в копию дня не едет — как и её журнал.
    expect(existsSync(join(day, 'attachments', 'gone'))).toBe(false);
  });

  it('a day already backed up is skipped; a crashed .partial day is rebuilt', () => {
    const dirs = layout();
    const at = new Date(2026, 9, 20, 9).getTime();
    mkdirSync(join(dirs.backupsDir, '2026-10-20.partial', 'junk'), { recursive: true });
    const first = runDailyBackup({ ...dirs, activeTaskIds: ['t1'], at });
    expect(first.skipped).toBe(false);
    expect(existsSync(join(dirs.backupsDir, '2026-10-20.partial'))).toBe(false);
    expect(existsSync(join(dirs.backupsDir, '2026-10-20', 'junk'))).toBe(false);
    const again = runDailyBackup({ ...dirs, activeTaskIds: ['t1'], at: at + 60_000 });
    expect(again.skipped).toBe(true);
  });

  it('M6 a journal with an event over 64 KB is backed up with its artifact: the restored copy reads back intact', () => {
    const dirs = layout();
    const taskId = newId();
    const dir = join(dirs.tasksDir, taskId);
    const writer = openWriter(dir, {
      taskId,
      clock: fakeClock(),
      mask: NO_MASK,
      nextSeq: 1,
      lastHash: genesisHash(taskId),
      holdsLease: () => true,
    });
    const big = 'я'.repeat(40_000);
    writer.append({ kind: 'error', actor: 'core', data: { code: 'big', detail: big } });
    writer.close();
    const out = runDailyBackup({
      ...dirs,
      activeTaskIds: [taskId],
      at: new Date(2026, 9, 21, 12).getTime(),
    });
    expect(out.failures).toEqual([]);
    // Восстановление = каталог задачи из копии; живой каталог удалён целиком.
    rmSync(dir, { recursive: true, force: true });
    const restored = join(dirs.backupsDir, '2026-10-21', 'tasks', taskId);
    const read = readJournalLines(restored, taskId);
    expect((read.lines[0]?.data as { detail: string }).detail).toBe(big);
  });

  it('M4 a file another process holds fails the copy by name, never throws; the day stays .partial and the next pass completes it', async () => {
    const dirs = layout();
    const at = new Date(2026, 9, 22, 9).getTime();
    const journal = join(dirs.tasksDir, 't1', TASK_FILES.journal);
    const release = await holdFile(journal, 'unreadable');
    let first;
    try {
      first = runDailyBackup({ ...dirs, activeTaskIds: ['t1'], at });
    } finally {
      await release();
    }
    expect(first.failures).toEqual([expect.stringMatching(/^t1\/journal: /)]);
    expect(existsSync(join(dirs.backupsDir, '2026-10-22'))).toBe(false);
    expect(existsSync(join(dirs.backupsDir, '2026-10-22.partial'))).toBe(true);
    const again = runDailyBackup({ ...dirs, activeTaskIds: ['t1'], at: at + 60_000 });
    expect(again).toMatchObject({ skipped: false, failures: [], copied: 2 });
    expect(
      readFileSync(join(dirs.backupsDir, '2026-10-22', 'tasks', 't1', TASK_FILES.journal), 'utf8'),
    ).toBe('{"seq":1}\n');
  }, 30_000);
});
