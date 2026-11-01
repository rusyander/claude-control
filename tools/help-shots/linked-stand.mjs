/**
 * Одноразовый стенд съёмки: нейтральный путь рядом с репозиторием — соединение
 * (junction) на настоящий каталог во временной папке ОС.
 *
 * Путь стенда попадает в кадр (команда MCP-сервера, путь хука, карточка системы),
 * а `%TEMP%` на Windows начинается с имени пользователя — поэтому кадр должен
 * видеть соседа репозитория. Ворота «решает только человек» (`human-only.ts`)
 * отбивают запрос не из браузера человека: `PATCH /api/settings` съёмки (язык,
 * тема, настройки сценариев) получал 403 `decision_device_unverified` до первого
 * кадра. Пропускают они только одноразовый стенд (`throwaway-stand.ts`): каталоги
 * конфигурации и данных, РАЗРЕШЁННЫЕ до настоящего пути, лежат в temp учётной
 * записи. Соединение даёт оба: кадр видит нейтральный путь, ворота — настоящий.
 *
 * Каталог помечается файлом-меткой: без метки и без нашего префикса цели ничего
 * не сносится — чужая папка с тем же именем остаётся на месте.
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Метка «каталог создан съёмкой» — без неё чужая папка не сносится. */
export const STAND_MARK = '.help-shots-owned';

/** Куда ведёт соединение `stand`; `undefined` — это не соединение (или его нет). */
function linkTarget(stand) {
  try {
    return lstatSync(stand).isSymbolicLink() ? readlinkSync(stand) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Завести стенд: настоящий каталог `<temp>/<prefix>XXXXXX`, соединение `stand` на
 * него и метка с именем съёмки. Остаток упавшей съёмки (соединение, в том числе
 * висячее, или прежний настоящий каталог с меткой) сначала убирается.
 */
export function makeLinkedStand(stand, prefix, owner) {
  dropLinkedStand(stand, prefix);
  if (linkTarget(stand) !== undefined || existsSync(stand)) {
    throw new Error(`${stand} уже существует и создан не съёмкой — выберите другой путь`);
  }
  const real = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  // 'junction' на Windows не требует прав администратора; на POSIX тип игнорируется.
  symlinkSync(real, stand, 'junction');
  writeFileSync(join(stand, STAND_MARK), `создан ${owner}\n`, 'utf8');
  return stand;
}

/**
 * Снести стенд — но только свой: соединение на каталог с нашим префиксом. Сначала
 * каталог, потом само соединение (`rmSync` через соединение рекурсивно не ходит —
 * снял бы только ссылку).
 */
export function dropLinkedStand(stand, prefix) {
  const target = linkTarget(stand);
  if (target === undefined) {
    // Стенд прежнего вида — настоящий каталог рядом с репозиторием, с меткой.
    if (existsSync(join(stand, STAND_MARK))) rmSync(stand, { recursive: true, force: true });
    return;
  }
  const owned = target
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.startsWith(prefix);
  if (!owned) return;
  if (existsSync(join(target, STAND_MARK))) rmSync(target, { recursive: true, force: true });
  unlinkSync(stand);
}
