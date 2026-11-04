import type { TaskRegistry } from '../../conductor/tasks.ts';
import { runDailyBackup } from '../../journal/backup.ts';
import { createClock, REAL_CLOCK, type CoreClock } from '../../platform/clock.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { Note } from './boot.types.ts';
import { reasonOf } from './release.ts';

export const BACKUP_EVERY_MS = 6 * 60 * 60_000;

/** Резервная копия дня: сразу и затем по таймеру; возвращает остановку таймера. */
export function startBackups(
  registry: TaskRegistry,
  layout: CoreHomeLayout,
  note: Note,
): () => void {
  const backup = (): void => {
    // Таймер копии не роняет ядро (ревью M4): проход сам не бросает, этот перехват — на
    // непредвиденное (снимок реестра, сбой ФС вне названных шагов).
    try {
      const live = registry.liveTasks().map((t) => t.taskId);
      const outcome = runDailyBackup({
        backupsDir: layout.backups,
        tasksDir: layout.tasks,
        profilesDir: layout.profiles,
        attachmentsDir: layout.attachments,
        activeTaskIds: live,
        at: Date.now(),
      });
      if (!outcome.skipped || outcome.failures.length) note('backup', { ...outcome });
    } catch (error) {
      note('backup', { failures: [reasonOf(error)] });
    }
  };
  backup();
  const timer = setInterval(backup, BACKUP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Тики часов ядра: скачок времени пишется в журнал каждой живой задачи. */
export function startClockJumps(
  registry: TaskRegistry,
  bootId: string,
  note: Note,
): { clock: CoreClock; stop: () => void } {
  // База тиков — сейчас, после всей работы загрузки: долгая загрузка не скачок часов (F-50).
  const clock = createClock(REAL_CLOCK, bootId);
  const stop = clock.start((jump) => {
    for (const task of registry.liveTasks()) {
      try {
        task.append({ kind: 'clock.jump', actor: 'core', data: jump });
      } catch (error) {
        // Задачу только что перехватили: её скачок запишет новый владелец.
        note('clock.jump.skipped', { taskId: task.taskId, reason: String(error) });
      }
    }
  });
  return { clock, stop };
}
