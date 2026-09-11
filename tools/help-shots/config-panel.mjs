/**
 * Кадры пачки «Настройка поведения»: десять сценариев одной съёмкой.
 *
 * Разделов пять, и все они про одно — чем настраивают поведение Claude Code:
 *
 *   skills/first      — скиллов нет: форма, заготовка тела, первая папка.
 *   skills/living     — скиллы есть: файлы, поиск, выключение, правка.
 *   commands/find     — найти команду: поиск и фильтры по источнику.
 *   commands/sources  — команда пропала: выключенный скилл, путь файла, реестр.
 *   hooks/first       — секции hooks нет: заготовки и первый хук.
 *   hooks/living      — хуки стоят: порядок, пропавший файл, локальная запись.
 *   scripts/files     — файлы в hooks/: пометки, содержимое, удаление.
 *   scripts/new       — нового файла нет: каркасы и пакетное создание.
 *   plugins/install   — поставить готовый: каталог, установка, источники.
 *   plugins/own       — написать свой: каркас в выбранной папке.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ, и для этой пачки это не формальность: её предмет — файлы
 * конфигурации. `CLAUDE_CONFIG_DIR` уводится в отдельный каталог, и панель
 * делает с ним всё по-настоящему: разбирает, создаёт, переносит, переписывает.
 * Личный `~/.claude` владельца машины не читается и не правится ни на шаг.
 *
 * Подменяется ровно один раздел — «Плагины»: за ним стоит установленный CLI и
 * поход в сеть за репозиториями маркетплейсов. Всё остальное в кадре —
 * настоящий ответ сервера панели, прочитавшего настоящий файл.
 *
 * Запуск: node tools/help-shots/config-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5196), GUIDE_WEB_PORT (8906),
 *             GUIDE_ONLY (имя одного сценария вида `skills/living`).
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { makeHome, makePluginsDir, drop, HOME_DIR, PLUGINS_DIR } from './config-fixture.mjs';
import { shootSkillsFirst, shootSkillsLiving } from './config-skills.mjs';
import { shootCommandsFind, shootCommandsSources } from './config-commands.mjs';
import { shootHooksFirst, shootHooksLiving } from './config-hooks.mjs';
import { shootScriptsFiles, shootScriptsNew } from './config-scripts.mjs';
import { shootPluginsInstall, shootPluginsOwn } from './config-plugins.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5196);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8906);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const started = [];
const home = makeHome();
makePluginsDir();

try {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
  };

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

  // Язык — до первого кадра и через настройки панели, а не через i18n в
  // странице: кадр должен доказывать тот путь, по которому язык приходит
  // человеку. `GUIDE_LANG=en` → английские кадры рядом с русскими.
  await applyShotLanguage(PANEL);

  started.push(
    spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: `${process.cwd()}/apps/web`,
        // BROWSER=none — иначе Vite откроет окно поверх съёмки.
        env: { ...env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 90))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  const browser = await chromium.launch();
  // GUIDE_ONLY сужает съёмку до одного сценария: правка селектора в конце пути
  // иначе проверяется полным прогоном всех десяти.
  const only = process.env.GUIDE_ONLY ?? '';
  const run = async (topic, name, shoot) => {
    if (only && only !== `${topic}/${name}`) return;
    const scenario = openScenario(topic, name);
    console.log(`\nсценарий ${topic}/${name}`);
    await shoot(browser, WEB, scenario, home);
    scenario.finish();
  };

  try {
    // Порядок важен: сценарии переписывают одни и те же файлы, и каждый
    // начинается с того, что кладёт нужное ему состояние. «Скрипты» идут до
    // «Хуков» — те создают в `hooks/` новый файл.
    await run('skills', 'first', shootSkillsFirst);
    await run('skills', 'living', shootSkillsLiving);
    await run('commands', 'find', shootCommandsFind);
    await run('commands', 'sources', shootCommandsSources);
    await run('scripts', 'files', shootScriptsFiles);
    await run('scripts', 'new', shootScriptsNew);
    await run('hooks', 'first', shootHooksFirst);
    await run('hooks', 'living', shootHooksLiving);
    await run('plugins', 'install', shootPluginsInstall);
    await run('plugins', 'own', shootPluginsOwn);
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  drop(HOME_DIR);
  drop(PLUGINS_DIR);
}
