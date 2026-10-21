/**
 * Отложенный перезапуск dev-сервера — общий файл сторожа (`dev-watch.mjs`) и
 * сервера. Сторож пишет, что правки ждут конца живых ходов, сервер показывает
 * это панели, а кнопка «перезапустить сейчас» оставляет сторожу запрос.
 *
 * Почему файлы, а не канал. Сервер — ребёнок сторожа только по stdio, и после
 * перезапуска это уже другой процесс; журнал прогонов (`runs.json`) сторож
 * читает так же, файлом в каталоге данных панели.
 */
/* global process */
import {
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

/** Состояние отложенного перезапуска: пишет сторож, читает сервер. */
export const DEV_RESTART_STATE = 'dev-restart.json';
/** Запрос человека «перезапустить сейчас»: оставляет сервер, забирает сторож. */
export const DEV_RESTART_REQUEST = 'dev-restart.request';
/**
 * Журнал решений сторожа: что перезапустило сервер, что отложено, почему.
 * Сторож под `pnpm keepalive` идёт с выброшенным stdout — без файла причину
 * перезапуска посреди групп было не восстановить (журнал 19.10, L6.1).
 */
export const DEV_WATCH_LOG = 'dev-watch.log';
const DEV_WATCH_LOG_MAX = 512 * 1024;

/** Строка в журнал сторожа; больше предела — прежний уходит в `.1`. */
export function appendDevLog(appData, line) {
  try {
    mkdirSync(appData, { recursive: true });
    const file = join(appData, DEV_WATCH_LOG);
    if (existsSync(file) && statSync(file).size > DEV_WATCH_LOG_MAX) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Каталог только для чтения — строка остаётся в stdout сторожа.
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Правки ждут: `since` — с какого времени, `files` — какие, `waitingFor` —
 * чего ждут (`runs` — идущих ходов, `setup` — подготовки копий, `both`);
 * `capAt` — когда сторож перезапустит, не дождавшись ходов, `runs` — какие
 * ходы он тогда не дождётся (папки их прогонов).
 */
export function writeRestartState(appData, state) {
  try {
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(appData, DEV_RESTART_STATE), JSON.stringify(state));
  } catch {
    // Каталога данных нет или он только для чтения — панель просто не узнает.
  }
}

export function clearRestartState(appData) {
  rmSync(join(appData, DEV_RESTART_STATE), { force: true });
}

/**
 * Что показать панели. Файл остался от сторожа, который уже не работает
 * (упал, погашен деревом), — ничего не ждёт: иначе плашка висела бы вечно.
 */
export function readRestartState(appData, isAlive = pidAlive) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(appData, DEV_RESTART_STATE), 'utf8'));
  } catch {
    return { pending: false };
  }
  if (!parsed || typeof parsed !== 'object') return { pending: false };
  if (typeof parsed.pid !== 'number' || !isAlive(parsed.pid)) return { pending: false };
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((file) => typeof file === 'string').slice(0, 20)
    : [];
  const waitingFor = ['runs', 'setup', 'checks', 'both'].includes(parsed.waitingFor)
    ? parsed.waitingFor
    : 'runs';
  const runs = Array.isArray(parsed.runs)
    ? parsed.runs.filter((run) => typeof run === 'string').slice(0, 5)
    : [];
  return {
    pending: true,
    ...(typeof parsed.since === 'string' ? { since: parsed.since } : {}),
    files,
    waitingFor,
    ...(typeof parsed.capAt === 'string' ? { capAt: parsed.capAt } : {}),
    ...(runs.length > 0 ? { runs } : {}),
    requested: existsSync(join(appData, DEV_RESTART_REQUEST)),
  };
}

export function requestRestart(appData) {
  writeFileSync(join(appData, DEV_RESTART_REQUEST), new Date().toISOString());
}

/** Забрать запрос: был — `true`, и больше его нет. */
export function takeRestartRequest(appData) {
  const file = join(appData, DEV_RESTART_REQUEST);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Предел ожидания ХОДОВ (владелец 21.10, D1). Без предела две группы с ходами по
 * 10–30 мин держали правку сервера больше часа (прогон 20.10). Процесс агента
 * перезапуск переживает, а группа, чей ход он всё же оборвал, продолжает сама
 * (E3); кэш за полчаса не остывает.
 * Подготовка копий и проверки предела не имеют: оборванные, они оставляют
 * полузаведённую копию (Ф11).
 */
export const RUNS_WAIT_CAP_MS = 30 * 60_000;

/** Ожидание ходов, начатое в `sinceMs`, упёрлось в предел; `capMs` 0 — предела нет. */
export function runsWaitCapped(sinceMs, now, capMs) {
  return capMs > 0 && sinceMs !== undefined && now - sinceMs >= capMs;
}

/**
 * Чего ждёт перезапуск: идущих ходов, подготовки копий, автотестов и проверок
 * поломкой проектов (`checks`, Ф11), нескольких из них сразу (`both`) — или
 * ничего (`undefined`). Ходы ждут до предела (`RUNS_WAIT_CAP_MS`) — его
 * сторож проверяет сам, сюда приходит уже «занято с учётом предела»; нетерпеливому —
 * кнопка в панели.
 */
export function deferReason(runsBusy, setupBusy, checksBusy = false) {
  const busy = [runsBusy && 'runs', setupBusy && 'setup', checksBusy && 'checks'].filter(Boolean);
  if (busy.length > 1) return 'both';
  return busy[0] || undefined;
}
