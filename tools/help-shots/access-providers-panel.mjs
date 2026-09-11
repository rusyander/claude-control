/**
 * Кадры путеводителей «Настройки», «Провайдеры», «Свой эндпоинт»,
 * «Интеграции» и «Защита данных» — одной съёмкой.
 *
 * Разделов пять, и все пять про одно: куда панель ходит, чем представляется и
 * что от этого остаётся на диске. Профиль эндпоинта, заведённый в одном
 * сценарии, — это тот же адрес, который выбирает прокси в другом; провайдер,
 * выбранный в третьем, решает, можно ли поставить гейт на промпте в четвёртом.
 * Пять отдельных съёмок означали бы пять разных стендов с пятью разными
 * представлениями об одном и том же.
 *
 * Сценарии делятся по входу, а не по объёму:
 *
 *   settings/first-run      — панель открыта впервые: четыре шага мастера,
 *                             каталог конфигурации и откуда берётся доступ.
 *   prompts/library         — тексты, которыми панель говорит с моделью сама:
 *                             правка живёт отдельно от встроенного текста.
 *   settings/safety         — всё уже работает: что панель делает ПЕРЕД
 *                             записью, что остаётся после и как это увезти.
 *   providers/switch        — в системе не только Claude: выбор провайдера,
 *                             живая проверка и сверка форматов со схемами.
 *   endpoints/local         — модель своя: профиль, проверка связи, кто из CLI
 *                             его примет и почему остальные — нет.
 *   integrations/atlassian  — Jira и фордж: ключ, живая проверка, определённый
 *                             диалект и те же инструменты агенту через MCP.
 *   integrations/notify     — уведомления: вебхук с подписью и Telegram.
 *   dlp/first               — прокси с нуля: правила, проверка на пробном
 *                             тексте, запуск и журнал после живого запроса.
 *   dlp/gate                — гейт на промпте: что он видит, а чего не видит.
 *
 * СТЕНД ОДНОРАЗОВЫЙ: `CLAUDE_CONFIG_DIR` и домашний каталог уводятся в соседний
 * каталог, и панель правит там всё по-настоящему. Личный `~/.claude` владельца
 * машины не читается и не правится ни на шаг.
 *
 * НЕ ПОДМЕНЯЕТСЯ НИ ОДИН ОТВЕТ ПАНЕЛИ. Единственное, что добавлено к съёмке, —
 * выдуманный «верх» на петле (`fakeUpstream`): модель, Jira, GitLab и приёмник
 * вебхука. Панель ходит к нему по-настоящему, и всё, что видно в кадре, она
 * посчитала сама.
 *
 * Запуск: node tools/help-shots/access-providers-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5197), GUIDE_WEB_PORT (8907),
 *             GUIDE_UPSTREAM_PORT (5297), GUIDE_DLP_PORT (5397),
 *             GUIDE_ONLY (имя одного сценария: first-run, switch, local…).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import {
  CONFIG_DIR,
  HOME_DIR,
  makeStand,
  dropStand,
  fakeUpstream,
  maskedScenario,
} from './access-providers-fixture.mjs';
import { shootFirstRun, shootSafety } from './access-settings.mjs';
import { shootLibrary } from './access-prompts.mjs';
import { shootSwitch } from './access-providers.mjs';
import { shootLocal } from './access-endpoints.mjs';
import { shootAtlassian, shootNotify } from './access-integrations.mjs';
import { shootDlpFirst, shootDlpGate } from './access-dlp.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5197);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8907);
/** Выдуманный верх: модель, Jira, GitLab и приёмник вебхука на одном порту. */
const UPSTREAM_PORT = Number(process.env.GUIDE_UPSTREAM_PORT ?? 5297);
/** Порт прокси защиты данных. Не 5179 из коробки: там уже сидит чужой стенд. */
const DLP_PORT = Number(process.env.GUIDE_DLP_PORT ?? 5397);

const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

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
makeStand();
const upstream = fakeUpstream(UPSTREAM_PORT);

try {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
    // Домашний каталог виден в путях, которые панель показывает целиком:
    // скрипт гейта, файл чужого CLI, каталог резервных копий.
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
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
      'node',
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(process.cwd(), 'apps', 'web'),
        // BROWSER=none — иначе Vite откроет окно поверх съёмки. Домашний каталог
        // фронту подменять нельзя: там кэш сборщика.
        env: { ...process.env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 120))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  const browser = await chromium.launch();
  // GUIDE_ONLY сужает съёмку до одного сценария: правка селектора в конце пути
  // иначе проверяется полным прогоном всех восьми.
  const only = process.env.GUIDE_ONLY ?? '';
  const context = {
    panel: PANEL,
    upstream: UPSTREAM,
    upstreamPort: UPSTREAM_PORT,
    dlpPort: DLP_PORT,
  };
  // Упавший сценарий не отменяет остальные: съёмка длинная, и один неверный
  // селектор не должен прятать за собой семь других. Итог прогона — код выхода.
  const broken = [];
  const run = async (topic, name, shoot) => {
    if (only && only !== name) return;
    const scenario = openScenario(topic, name);
    console.log(`\nсценарий ${topic}/${name}`);
    // Список замазываний общий на всю пачку и ставится здесь: у сценария нет
    // повода его знать, а забыть его на одном кадре из сорока — значит увезти
    // в справку настоящий адрес машины, на которой шла съёмка.
    try {
      await shoot(browser, WEB, maskedScenario(scenario), context);
    } catch (error) {
      broken.push(`${topic}/${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`  ОТКАЗ: ${error instanceof Error ? error.message : String(error)}`);
    }
    scenario.finish();
  };

  try {
    // Порядок важен: сценарии переписывают одни и те же настройки панели, и
    // каждый начинается с того, что кладёт нужное ему состояние. «Свой
    // эндпоинт» идёт до «Защиты данных» — прокси выбирает его профиль.
    await run('settings', 'first-run', shootFirstRun);
    await run('settings', 'safety', shootSafety);
    await run('prompts', 'library', shootLibrary);
    await run('providers', 'switch', shootSwitch);
    await run('endpoints', 'local', shootLocal);
    await run('integrations', 'atlassian', shootAtlassian);
    await run('integrations', 'notify', shootNotify);
    await run('dlp', 'first', shootDlpFirst);
    await run('dlp', 'gate', shootDlpGate);
    if (broken.length) {
      console.log(`\nсценариев с отказом: ${broken.length}`);
      for (const line of broken) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
} finally {
  upstream.close();
  for (const child of started) child.kill();
  dropStand();
}
