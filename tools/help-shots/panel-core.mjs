/**
 * Своё ядро одноразовой панели съёмки справки (этап 10, зона C, проход 7).
 *
 * Панель поднимает ядро сама (надзор, этап 10). Съёмщик, запускавший панель с окружением оболочки,
 * отдавал надзору дом человека: ядро панели съёмки садилось на `~/.agentdeck/core` (усыновляло ядро
 * человека или поднимало второе в его доме), а ядро на доме `~/.agentdeck/core` всегда слушает шлюз
 * из настроек панели — 5179, адрес человека. Съёмщик с подменённым `HOME` уводил дом, но шлюз всё
 * равно брал 5179: ядро на «своём» `~/.agentdeck/core` считает себя ядром человека.
 *
 * Здесь — то же, что делает одноразовый стенд (`tools/qa/throwaway-stand.mjs`): свой дом
 * (`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`, переменные панели человека не наследуются), свой
 * дом ядра (`AGENTDECK_CORE_HOME`) и окружение ядра стенда (`standCoreEnv`: данные панели и свой
 * свободный порт шлюза). Надзор ВКЛЮЧЁН: кадры показывают настоящее ядро под надзором, только не
 * человека. Снятие — по записям под своим каталогом (`reapStandTree`), ни по имени процесса; оно же
 * повешено на выход процесса съёмщика, так что ядро уходит и при падении съёмки.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { brandEnvName, legacyEnvName } from '../../apps/server/src/lib/brand.mjs';
import { freePort, reapStandTree, standCoreEnv } from '../qa/throwaway-stand.mjs';
import { shotHome } from './kit.mjs';

const PANEL_ENV_PREFIXES = [brandEnvName(''), legacyEnvName('')];
const HOME_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
const IS_WIN = process.platform === 'win32';
const norm = (path) => (IS_WIN ? resolve(path).toLowerCase() : resolve(path));

/**
 * Дом съёмщика — дом человека? Тогда панели нужен свой. Подменённый дом съёмщика (стенд доступа,
 * переносимости) остаётся: на нём засеяны кадры.
 */
function isOwnersHome(env) {
  const real = norm(homedir());
  const home = env.USERPROFILE ?? env.HOME;
  return !home || norm(home) === real || (env.HOME !== undefined && norm(env.HOME) === real);
}

/**
 * Окружение панели съёмки со своим ядром. `env` — окружение, которое съёмщик собрал для панели
 * (`CLAUDE_CONFIG_DIR` обязателен — по нему лежат данные панели). Ответ: `env` для `spawn`
 * сервера, `coreHome`, `root` и `reap()` — снять ядро и его хосты и удалить свой каталог
 * (повторный вызов ничего не делает; на выходе процесса зовётся сам).
 */
export async function isolatePanelCore(env, { label = 'help' } = {}) {
  const root = shotHome(`cc-${label}-core-`);
  const coreHome = join(root, 'core-home');
  mkdirSync(coreHome, { recursive: true });
  const ownHome = isOwnersHome(env);
  const home = ownHome ? join(root, 'home') : (env.USERPROFILE ?? env.HOME);
  const homeEnv = ownHome
    ? {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
      }
    : {};
  for (const dir of Object.values(homeEnv)) mkdirSync(dir, { recursive: true });
  const panelData = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'agentdeck') : undefined;
  // Переменные панели человека (дом ядра, данные, порт шлюза, токен) увели бы панель съёмки в его
  // каталоги. Явные переменные съёмщика из своего набора (`AGENTDECK_TELEGRAM_API` и т. п.)
  // остаются: их съёмщик ставит сам, поверх оболочки.
  const shellPanelVars = new Set(
    Object.keys(process.env).filter((key) =>
      PANEL_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix)),
    ),
  );
  const base = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        !(shellPanelVars.has(key) && process.env[key] === value) &&
        !(ownHome && HOME_KEYS.includes(key.toUpperCase())),
    ),
  );
  const isolated = { platformGateway: { port: await freePort() } };
  const out = {
    ...base,
    ...homeEnv,
    AGENTDECK_OPEN_BROWSER: '0',
    AGENTDECK_CORE_SUPERVISE: '1',
    AGENTDECK_CORE_HOME: coreHome,
    ...standCoreEnv(true, isolated, panelData),
  };
  let done = false;
  const reap = () => {
    if (done) return { left: [] };
    done = true;
    process.removeListener('exit', reap);
    const { left } = reapStandTree(root, { settleMs: 5_000 });
    for (const id of left)
      console.log(`съёмка: не снят процесс ядра (${id.role}) pid ${id.pid}: ${id.why}`);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      console.log(`съёмка: каталог ядра ${root} не удалён: ${error.message}`);
    }
    return { left };
  };
  process.once('exit', reap);
  reaps.push(reap);
  return { env: out, coreHome, root, gatewayPort: isolated.platformGateway.port, reap };
}

const reaps = [];

/** Окружение панели съёмки со своим ядром — короткая форма для съёмщика (`spawn` сервера). */
export async function panelEnv(env, options) {
  return (await isolatePanelCore(env, options)).env;
}

/**
 * Снять ядра всех панелей съёмки этого процесса — в `finally` съёмщика ПОСЛЕ снятия панели (иначе
 * надзор поднял бы ядро снова) и ДО сноса его каталогов: ядро читает данные панели из каталога
 * конфигурации съёмщика.
 */
export function reapPanelCores() {
  const left = [];
  for (const reap of reaps.splice(0)) left.push(...reap().left);
  return left;
}
