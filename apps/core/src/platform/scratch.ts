import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir } from './safe-io/files.ts';

/**
 * Рабочий каталог лёгкой сессии «ask» (этап 10, F2): временный каталог ОС, не дом ядра — дом ядра
 * для сессии защищённый корень платформы, и CLI в нём не пустили бы ни читать, ни писать. Имя —
 * по задаче: тот же каталог находит и старт сессии, и снятие на конце задачи (`releaseTmp`).
 */
export const SCRATCH_PREFIX = 'agentdeck-ask-';

export function scratchDirOf(taskId: string): string {
  return join(tmpdir(), `${SCRATCH_PREFIX}${taskId}`);
}

export function makeScratchDir(taskId: string): string {
  const dir = scratchDirOf(taskId);
  ensureDir(dir);
  return dir;
}
