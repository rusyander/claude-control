/**
 * Кадры пяти «наблюдательных» разделов одной съёмкой: обзор, поиск, аналитика,
 * история, сравнение.
 *
 * Разделы сняты вместе потому, что у них ОДИН источник — каталог конфигурации.
 * Плитка обзора, строка поиска, отчёт аналитики, лента истории и таблица
 * сравнения читают одни и те же файлы разными читалками; пять стендов означали
 * бы пять копий этих файлов, которые разойдутся в первую же правку.
 *
 * Сценарии делятся ПО ВХОДУ:
 *
 *   overview/tour      — первый запуск: где лежит конфигурация и что в ней есть;
 *   overview/trouble   — «числа не те»: не тот каталог и сломанный хук;
 *   search/find        — помню слово, не помню раздел;
 *   analytics/report   — сколько наработали за период;
 *   analytics/live     — что идёт прямо сейчас;
 *   history/trace      — кто поменял файл и как вернуть один кусок;
 *   compare/look       — что настроено у одного CLI и нет у другого;
 *   compare/move       — перенести запись и увидеть, что панель откажется.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ: свой каталог конфигурации, свой `CODEX_HOME`, свои порты,
 * свой фронт. Рабочий стенд и настоящий `~/.claude` не трогаются вовсе.
 *
 * Каталог фикстуры лежит РЯДОМ с репозиторием, а не во временной папке системы:
 * системный путь на Windows содержит имя пользователя, а оно уехало бы в кадр
 * сравнения — там путь к файлу каждой стороны пишет сервер.
 *
 * Запуск: node tools/help-shots/watching-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5198), GUIDE_WEB_PORT (8908),
 *             GUIDE_ONLY — снять один сценарий (tour|trouble|find|report|live|
 *             trace|look|move).
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { buildFixture, breakHook, healHook } from './watching-fixture.mjs';
import { shootTour, shootTrouble } from './watching-overview.mjs';
import { shootFind } from './watching-search.mjs';
import { shootReport, shootLive } from './watching-analytics.mjs';
import { shootTrace } from './watching-history.mjs';
import { shootLook, shootMove } from './watching-compare.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5198);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8908);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const HOME = resolve(ROOT, '..', '.cc-help-watching');

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

/**
 * Порядок значим: «тревожный» сценарий ломает хук в settings.json, и соседние
 * кадры не должны застать конфигурацию в этом виде.
 */
const SCENARIOS = [
  { only: 'tour', topic: 'overview', name: 'tour', shoot: shootTour },
  { only: 'trouble', topic: 'overview', name: 'trouble', shoot: shootTrouble, breaks: true },
  { only: 'find', topic: 'search', name: 'find', shoot: shootFind },
  { only: 'report', topic: 'analytics', name: 'report', shoot: shootReport },
  { only: 'live', topic: 'analytics', name: 'live', shoot: shootLive },
  { only: 'trace', topic: 'history', name: 'trace', shoot: shootTrace },
  { only: 'look', topic: 'compare', name: 'look', shoot: shootLook },
  { only: 'move', topic: 'compare', name: 'move', shoot: shootMove },
];

const started = [];
rmSync(HOME, { recursive: true, force: true });
const fixture = buildFixture(HOME);
// Корень фикстуры знают и сценарии: пути к файлам на кадре сравнения пишет
// сервер, и перед снимком они переселяются в домашний каталог человека.
process.env.GUIDE_FIXTURE_HOME = HOME;

try {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: fixture.root,
    // Чужой CLI уводится в свой каталог: перенос в сравнении ПИШЕТ файл, и без
    // этого он писал бы в настоящий ~/.codex человека.
    CODEX_HOME: fixture.codexHome,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
  };

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { cwd: ROOT, env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

  // Язык — до первого кадра и через настройки панели: кадр должен доказывать
  // тот путь, по которому язык приходит человеку. GUIDE_LANG=en → английские
  // кадры рядом с русскими.
  await applyShotLanguage(PANEL);

  started.push(
    spawn(
      process.execPath,
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(ROOT, 'apps', 'web'),
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
  const only = process.env.GUIDE_ONLY ?? '';
  try {
    for (const item of SCENARIOS) {
      if (only && only !== item.only) continue;
      const scenario = openScenario(item.topic, item.name);
      console.log(`\nсценарий ${item.topic}/${item.name}`);
      if (item.breaks) breakHook(fixture.root);
      try {
        await item.shoot(browser, WEB, scenario);
      } finally {
        if (item.breaks) healHook(fixture.root);
      }
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  rmSync(HOME, { recursive: true, force: true });
}
