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
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStandTree } from '../qa/throwaway-stand.mjs';

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
  writeFileSync(join(stand, STAND_MARK), `создан ${owner}\npid ${process.pid}\n`, 'utf8');
  return stand;
}

/**
 * Стенд держит ЖИВАЯ съёмка другого процесса? Один путь (`C:/work/claude-help-config`) делят
 * съёмки «Настройки поведения», переносимости и агента панели. 03.11.2026 две съёмки шли
 * одновременно: вторая снесла стенд первой как «остаток упавшей», панель первой досоздала
 * каталог по тому же пути уже без соединения и метки, и обе упали — у переносимости пропали
 * английские кадры subscribe, следующий запуск отказывался от «чужой» папки. Метка помнит pid
 * съёмки; пока он жив, стенд не сносится, а запуск отказывает с этим pid.
 */
function liveOwnerPid(markFile) {
  let text;
  try {
    text = readFileSync(markFile, 'utf8');
  } catch {
    return undefined;
  }
  const pid = Number(/^pid (\d+)$/m.exec(text)?.[1]);
  if (!pid || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return error?.code === 'EPERM' ? pid : undefined;
  }
}

function refuseLive(stand, markFile) {
  const pid = liveOwnerPid(markFile);
  if (pid !== undefined) {
    throw new Error(
      `${stand} держит живая съёмка (pid ${pid}) — дождитесь её конца; две съёмки на одном стенде сносят друг другу каталог`,
    );
  }
}

/**
 * Снос с ожиданием: съёмка гасит панель и сразу сносит стенд, а ядро панели (свой процесс)
 * ещё держит `.agentdeck/core` и выходит само через несколько секунд — Windows отвечал
 * EBUSY, и прогон падал кодом 1 уже после снятых кадров (03.11.2026). Ждём до 45 с.
 */
function rmBusy(path) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const busy = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code);
      if (!busy || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/**
 * Процессы ядра стенда — до сноса (проход 6, 03.11). Панель съёмки с подменённым домом поднимает
 * СВОЁ ядро надзором (`<стенд>/home/.agentdeck/core`), а ядро — хост звеньев, отвязанный по замыслу:
 * снятие панели его не уносило, хост жил после съёмки и держал каталог (девять `cc-help-*` за день).
 * Снимается только записанное ядром под каталогом стенда (`reapStandTree`).
 */
function reapStand(dir) {
  const { left } = reapStandTree(dir);
  for (const id of left)
    console.log(`стенд съёмки: не снят процесс ядра (${id.role}) pid ${id.pid}: ${id.why}`);
}

/**
 * Снести стенд — но только свой: соединение на каталог с нашим префиксом. Сначала
 * процессы ядра под ним, затем каталог, потом само соединение (`rmSync` через соединение
 * рекурсивно не ходит — снял бы только ссылку).
 */
export function dropLinkedStand(stand, prefix) {
  const target = linkTarget(stand);
  if (target === undefined) {
    // Стенд прежнего вида — настоящий каталог рядом с репозиторием, с меткой.
    if (existsSync(join(stand, STAND_MARK))) {
      refuseLive(stand, join(stand, STAND_MARK));
      reapStand(stand);
      rmBusy(stand);
    }
    return;
  }
  const owned = target
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.startsWith(prefix);
  if (!owned) return;
  refuseLive(stand, join(target, STAND_MARK));
  if (existsSync(join(target, STAND_MARK))) {
    reapStand(target);
    rmBusy(target);
  }
  unlinkSync(stand);
}
