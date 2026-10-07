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
import { readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Состояние отложенного перезапуска: пишет сторож, читает сервер. */
export const DEV_RESTART_STATE = 'dev-restart.json';
/** Запрос человека «перезапустить сейчас»: оставляет сервер, забирает сторож. */
export const DEV_RESTART_REQUEST = 'dev-restart.request';

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
 * чего ждут (`runs` — идущих ходов, `setup` — подготовки копий, `both`).
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
  return {
    pending: true,
    ...(typeof parsed.since === 'string' ? { since: parsed.since } : {}),
    files,
    waitingFor,
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
 * Чего ждёт перезапуск: идущих ходов, подготовки копий, автотестов и проверок
 * поломкой проектов (`checks`, Ф11), нескольких из них сразу (`both`) — или
 * ничего (`undefined`). Предела у ожидания нет: оборванный ход, `npm ci` копии
 * или прогон тестов дороже правки, которая подождёт; нетерпеливому — кнопка в панели.
 */
export function deferReason(runsBusy, setupBusy, checksBusy = false) {
  const busy = [runsBusy && 'runs', setupBusy && 'setup', checksBusy && 'checks'].filter(Boolean);
  if (busy.length > 1) return 'both';
  return busy[0] || undefined;
}
