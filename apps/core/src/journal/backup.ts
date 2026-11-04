import { join } from 'node:path';
import { copyFile, ensureDir, listDir, pathExists, renamePath } from '../platform/safe-io/files.ts';
import { removeVerified } from '../platform/safe-io/remove.ts';
import { TASK_FILES } from './journal.types.ts';

/**
 * Ежедневная копия (01 §Versioning, backup): журналы активных задач с их артефактами и профили —
 * в `backups/<YYYY-MM-DD>/`, хранятся последние 7. День собирается в `<день>.partial` и
 * переименовывается последним шагом: каталог дня есть — значит копия полная, второй раз не
 * копируем; крах или отказ посреди копии оставляет `.partial`, который следующий проход
 * пересоберёт. Закрытые журналы ядро не удаляет никогда (их сжатие через 30 дней — фаза 9).
 *
 * Артефакты входят в копию (ревью M6): строка больше 64 КБ хранит в журнале только `dataRef`,
 * и восстановленный без `artifacts/` журнал не читался бы. Проход ничего не бросает: он идёт из
 * таймера ядра, а исключение там роняет процесс (ревью M4); каждый отказ назван в `failures`.
 */

export const BACKUPS_KEPT = 7;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface BackupOutcome {
  day: string;
  copied: number;
  skipped: boolean;
  pruned: string[];
  failures: string[];
}

const PARTIAL_DAY = /^\d{4}-\d{2}-\d{2}\.partial$/;

/** Местный календарный день — как его видит человек; UTC сдвигал копию на вчера (ревью F-102). */
export function backupDay(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Чтение каталога, которое не бросает: проход идёт из таймера ядра (ревью F-102, M4). */
function listSafe(path: string): ReturnType<typeof listDir> {
  try {
    return listDir(path);
  } catch (error) {
    return { unknown: reason(error) };
  }
}

export function runDailyBackup(opts: {
  backupsDir: string;
  tasksDir: string;
  profilesDir: string;
  /** Корень копий вложений чата (`layout.attachments`, вне дома): каталог задачи едет рядом с журналом. */
  attachmentsDir?: string;
  activeTaskIds: readonly string[];
  at: number;
}): BackupOutcome {
  const day = backupDay(opts.at);
  const target = join(opts.backupsDir, day);
  const outcome: BackupOutcome = { day, copied: 0, skipped: false, pruned: [], failures: [] };
  const attempt = (what: string, step: () => void): boolean => {
    try {
      step();
      return true;
    } catch (error) {
      outcome.failures.push(`${what}: ${reason(error)}`);
      return false;
    }
  };
  const copy = (what: string, from: string, to: string): void => {
    if (attempt(what, () => copyFile(from, to))) outcome.copied += 1;
  };

  if (pathExists(target)) {
    outcome.skipped = true;
  } else {
    const partial = `${target}.partial`;
    if (pathExists(partial)) {
      const stale = removeVerified(partial);
      if (!stale.removed) outcome.failures.push(`${day}.partial: ${stale.reason}`);
    }
    const before = outcome.failures.length;
    if (attempt(`${day}.partial`, () => ensureDir(partial))) {
      for (const taskId of opts.activeTaskIds) {
        copyTask(taskId, partial, opts.tasksDir, copy, outcome);
        if (opts.attachmentsDir) {
          copyAttachments(taskId, partial, opts.attachmentsDir, copy, outcome);
        }
      }
      const profiles = listSafe(opts.profilesDir);
      // Нечитаемые профили — названный сбой копии, а не «профилей нет» (P44).
      if ('unknown' in profiles) outcome.failures.push(`profiles: ${profiles.unknown}`);
      if ('value' in profiles) {
        for (const name of profiles.value) {
          copy(`profiles/${name}`, join(opts.profilesDir, name), join(partial, 'profiles', name));
        }
      }
      // Неполный день не становится «полным»: `.partial` остаётся, следующий проход повторит.
      if (outcome.failures.length === before) attempt(day, () => renamePath(partial, target));
    }
  }
  const days = listSafe(opts.backupsDir);
  if ('unknown' in days) outcome.failures.push(`backups: ${days.unknown}`);
  if ('value' in days) {
    const sorted = days.value.filter((d) => DAY.test(d)).sort();
    // `.partial` прошедшего дня уже никто не пересоберёт (собирается только сегодняшний), а
    // ротация видит лишь полные дни — без этого он жил вечно (ревью F-102).
    const stalePartials = days.value.filter((d) => PARTIAL_DAY.test(d) && d !== `${day}.partial`);
    for (const old of [
      ...stalePartials,
      ...sorted.slice(0, Math.max(0, sorted.length - BACKUPS_KEPT)),
    ]) {
      const removed = removeVerified(join(opts.backupsDir, old));
      if (removed.removed) outcome.pruned.push(old);
      else outcome.failures.push(`${old}: ${removed.reason}`);
    }
  }
  return outcome;
}

/**
 * Копии вложений задачи (s10 G11): `<корень>/<taskId>/<cmdId>/<имя>` → `<день>/attachments/<taskId>/…`.
 * Каталога нет — у задачи нет вложений, это не сбой; нечитаемый — названный сбой копии.
 */
function copyAttachments(
  taskId: string,
  partial: string,
  attachmentsDir: string,
  copy: (what: string, from: string, to: string) => void,
  outcome: BackupOutcome,
): void {
  const from = join(attachmentsDir, taskId);
  if (!pathExists(from)) return;
  const to = join(partial, 'attachments', taskId);
  const slots = listSafe(from);
  if ('unknown' in slots) outcome.failures.push(`${taskId}/attachments: ${slots.unknown}`);
  if (!('value' in slots)) return;
  for (const slot of slots.value) {
    const names = listSafe(join(from, slot));
    if ('unknown' in names)
      outcome.failures.push(`${taskId}/attachments/${slot}: ${names.unknown}`);
    if (!('value' in names)) continue;
    for (const name of names.value) {
      copy(`${taskId}/attachments/${slot}/${name}`, join(from, slot, name), join(to, slot, name));
    }
  }
}

function copyTask(
  taskId: string,
  partial: string,
  tasksDir: string,
  copy: (what: string, from: string, to: string) => void,
  outcome: BackupOutcome,
): void {
  const from = join(tasksDir, taskId);
  const to = join(partial, 'tasks', taskId);
  if (!pathExists(join(from, TASK_FILES.journal))) return;
  copy(`${taskId}/journal`, join(from, TASK_FILES.journal), join(to, TASK_FILES.journal));
  const artifacts = listSafe(join(from, TASK_FILES.artifacts));
  if ('unknown' in artifacts) outcome.failures.push(`${taskId}/artifacts: ${artifacts.unknown}`);
  if (!('value' in artifacts)) return;
  for (const name of artifacts.value) {
    copy(
      `${taskId}/artifacts/${name}`,
      join(from, TASK_FILES.artifacts, name),
      join(to, TASK_FILES.artifacts, name),
    );
  }
}
