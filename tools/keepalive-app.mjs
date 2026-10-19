/**
 * Окно приложения при старте Windows — часть сторожа (`keepalive.mjs`).
 *
 * Панель, установленная как приложение (манифест `apps/web/public/manifest.webmanifest`),
 * живёт в своём окне со своим значком в панели задач. Сторож открывает это окно
 * сам — ОДИН раз за загрузку системы и только когда обе половины стенда уже
 * отвечают: раньше окно показало бы «сайт недоступен». Один раз — потому что
 * задача-подхват поднимает сторож каждые 5 минут, и окно, закрытое человеком,
 * не должно возвращаться само.
 *
 * Включается отдельно (`pnpm keepalive:app`): сторож без окна по-прежнему
 * нужен тем, кто держит панель во вкладке.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_URL = 'http://127.0.0.1:8888/';

/** Имя ярлыка совпадает с `name` в манифесте: так его называет браузер при установке. */
const APP_NAME = 'AgentDeck';

/**
 * Насколько могут разойтись два расчёта момента загрузки: `uptime` округлён до
 * секунды, а часы за время работы подводит синхронизация.
 */
const BOOT_DRIFT_MS = 120_000;

/** Включено ли окно при старте: флаг-файл, который пишет `pnpm keepalive:app`. */
export function appFlagPath(stateDir) {
  return join(stateDir, 'open-app');
}

/** Отметка «в эту загрузку окно уже открывали». */
export function appMarkerPath(stateDir) {
  return join(stateDir, 'app-opened');
}

export function setOpenApp(stateDir, on) {
  if (on) writeFileSync(appFlagPath(stateDir), 'on\n');
  else rmSync(appFlagPath(stateDir), { force: true });
}

export function openAppEnabled(stateDir) {
  return existsSync(appFlagPath(stateDir));
}

/** Момент загрузки системы, мс. */
export function bootTime(now = Date.now(), uptimeSec) {
  return now - uptimeSec * 1000;
}

/** Открывали ли окно в ЭТУ загрузку: отметка хранит момент загрузки, при которой её поставили. */
export function openedThisBoot(markerText, bootAt) {
  const marked = Number(String(markerText ?? '').trim());
  if (!Number.isFinite(marked) || marked <= 0) return false;
  return Math.abs(marked - bootAt) < BOOT_DRIFT_MS;
}

export function readMarker(stateDir) {
  try {
    return readFileSync(appMarkerPath(stateDir), 'utf8');
  } catch {
    return '';
  }
}

export function writeMarker(stateDir, bootAt) {
  writeFileSync(appMarkerPath(stateDir), `${Math.round(bootAt)}\n`);
}

/**
 * Где браузер кладёт ярлык установленного приложения. Chrome — в «Chrome
 * Apps», Edge — прямо в «Программы»; ярлык открывает приложение в его окне,
 * а не вкладкой.
 */
export function shortcutCandidates(env) {
  const programs = join(env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return [
    join(programs, 'Chrome Apps', `${APP_NAME}.lnk`),
    join(programs, `${APP_NAME}.lnk`),
    join(programs, 'Edge Apps', `${APP_NAME}.lnk`),
  ];
}

/**
 * Браузеры, которые умеют `--app=` — окно без вкладок и адресной строки. Это
 * запасной путь, когда приложение не установлено: окно то же, только значок в
 * панели задач браузерный.
 */
export function appBrowserCandidates(env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const paths = [];
  for (const root of roots) {
    paths.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    paths.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return paths;
}

/**
 * Чем открыть окно: `{ command, args, how }` или `null`, если нечем. Вкладку
 * обычного браузера не открываем никогда — от неё и уходили.
 */
export function resolveAppLaunch(env, exists = existsSync) {
  const shortcut = shortcutCandidates(env).find((path) => exists(path));
  if (shortcut) {
    const explorer = join(env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    return { command: explorer, args: [shortcut], how: `ярлык ${shortcut}` };
  }
  const browser = appBrowserCandidates(env).find((path) => exists(path));
  if (browser) return { command: browser, args: [`--app=${APP_URL}`], how: `${browser} --app` };
  return null;
}

/** Открыть окно отвязанным процессом: сторож не ждёт его и не держит. */
export function launchApp(launch) {
  const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
