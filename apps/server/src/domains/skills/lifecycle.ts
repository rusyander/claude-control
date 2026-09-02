import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backupEntry, copyRecursive, removeEntry } from '../../lib/safe-io.ts';
import type { AppStore } from '../../lib/app-store.ts';
import { assertSkillId, disabledSkillsDir, SKILLS_DISABLED_DIR } from './paths.ts';

/**
 * Судьба папки скилла: включение, переименование, удаление. Содержимое
 * `SKILL.md` здесь не трогается — только сама папка и отметки в state.json.
 */

/** Включение и выключение — перенос папки между skills/ и skills-disabled/. */
export function setSkillEnabled(skillsDir: string, skillId: string, isEnabled: boolean): void {
  assertSkillId(skillId);
  const disabledDir = disabledSkillsDir(skillsDir);
  const from = isEnabled ? join(disabledDir, skillId) : join(skillsDir, skillId);
  const to = isEnabled ? join(skillsDir, skillId) : join(disabledDir, skillId);

  if (!existsSync(from)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
}

/**
 * Ошибка переименования с машиночитаемым кодом — маршрут по нему выбирает
 * статус ответа (404 против 400), а текст показывается пользователю как есть.
 */
function skillError(code: 'invalid_name' | 'not_found' | 'name_taken', message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Одна ли это папка на диске. Windows не различает регистр и слэши в пути. */
function pathsEqual(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}

/**
 * Переименование скилла = переименование его папки + перенос отметок в state.json.
 *
 * Имя папки и есть идентификатор скилла, поэтому меняется именно папка. На
 * Windows прямой renameSync не годится в двух случаях: смена только регистра
 * («Foo» → «foo») — файловая система считает такие пути одним, — и кириллица
 * в имени. Поэтому переносим через промежуточную папку с ASCII-именем
 * поштучными операциями (copyRecursive/removeEntry), теми же, что надёжно
 * работают в safe-io. Выключенный скилл лежит в skills-disabled/ — там его и
 * переименовываем, оставляя выключенным.
 */
export function renameSkill(
  skillsDir: string,
  oldId: string,
  newIdRaw: string,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  assertSkillId(oldId);
  const newId = newIdRaw.trim();

  // Имя станет именем папки: пустое, со слэшами или «..» перепишет чужую папку
  // или выведет за пределы skills/ — отвергаем до любых файловых операций.
  // Ошибка своя, а не `InvalidSkillIdError`: текст уходит человеку в форму.
  if (!newId || /[/\\]/.test(newId) || newId === '.' || newId === '..' || newId.includes('\0')) {
    throw skillError('invalid_name', 'Недопустимое имя скилла.');
  }

  const disabledDir = disabledSkillsDir(skillsDir);
  const base = existsSync(join(skillsDir, oldId))
    ? skillsDir
    : existsSync(join(disabledDir, oldId))
      ? disabledDir
      : undefined;
  if (!base) throw skillError('not_found', 'Скилл не найден.');

  const source = join(base, oldId);
  const target = join(base, newId);

  // Смена только регистра: source и target на Windows — одна папка, existsSync
  // вернёт true. Это не «занято», а ровно наш случай, поэтому проверяем отдельно.
  if (newId === oldId) return undefined; // точное совпадение — переименовывать нечего

  const caseOnly = pathsEqual(source, target);
  if (!caseOnly && existsSync(target)) {
    throw skillError('name_taken', 'Скилл с таким именем уже есть.');
  }

  const backupPath = backupDir
    ? backupEntry(source, backupDir, `${basename(base)}-${oldId}`)
    : undefined;

  // Промежуточная папка снимает и проблему регистра (source и target — одна
  // папка), и кириллицы (перенос идёт поштучно, а не рекурсивным cpSync).
  const staging = join(base, `.rename-${process.pid}-${Date.now()}`);
  copyRecursive(source, staging);
  removeEntry(source);
  copyRecursive(staging, target);
  removeEntry(staging);

  // Отметки в state.json (выключение, гашение группой, состав групп) завязаны
  // на старый id — переносим их на новый, иначе они осиротеют.
  store.renameEntity('skill', oldId, newId);

  return backupPath;
}

/**
 * Удаление скилла стирает папку целиком, и отменить это нечем — поэтому копия
 * снимается до `rmSync`. Скилл может лежать в обеих папках сразу (руками
 * положили и туда, и туда), и копии тогда различаются именем корня.
 */
export function deleteSkill(
  skillsDir: string,
  skillId: string,
  backupDir?: string,
): string | undefined {
  assertSkillId(skillId);
  let backupPath: string | undefined;

  for (const dir of [
    join(skillsDir, skillId),
    join(skillsDir, '..', SKILLS_DISABLED_DIR, skillId),
  ]) {
    if (!existsSync(dir)) continue;

    const made = backupDir
      ? backupEntry(dir, backupDir, `${basename(dirname(dir))}-${skillId}`)
      : undefined;
    backupPath ??= made;

    // removeEntry, а не rmSync: у скилла может быть нелатинское имя, а
    // рекурсивный rmSync на такой папке рапортует об успехе, ничего не удалив.
    removeEntry(dir);
  }

  return backupPath;
}
