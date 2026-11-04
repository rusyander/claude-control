/**
 * Кадры путеводителя «Агент панели» — одной съёмкой.
 *
 * Сценарии делятся по входу:
 *
 *   panelAgent/first   — человек хочет, чтобы панель сделала что-то по его
 *                        словам: окно, карточка изменения, итог и открытая
 *                        страница, дифф правила, опасное действие с фокусом на
 *                        «Отклонить», след действий и история разговоров.
 *   panelAgent/guards  — агент отказал или «чего-то не сделал»: ключ контура
 *                        только у человека, ключ из чата маскируется, карточка
 *                        устарела, секрет MCP, сломанные правила маскирования,
 *                        второй ход в том же разговоре.
 *
 * СТЕНД ОДНОРАЗОВЫЙ: `CLAUDE_CONFIG_DIR` и домашний каталог уводятся в каталог
 * рядом с репозиторием и сносятся в конце. Личный `~/.claude` не читается.
 *
 * ПОДМЕНЕНА ТОЛЬКО МОДЕЛЬ (этап 10). Ход агента идёт через ядро: панель, своё ядро
 * (`apps/core`, дом в стенде) и НАСТОЯЩИЙ `claude` из PATH человека, у сессии которого
 * из инструментов только мост `panel-bridge` (`tools/mcp/panel.mjs`). Профиль
 * «Ассистент панели» — свой адрес на заглушку модели (`panel-agent-model.mjs` поверх
 * сценария `packages/stub-model`), ключ — в хранилище панели, ядро берёт его маршрутом
 * `api-key:endpoint:stub`. Карточки, диффы, исходы, след действий и файлы разговоров в
 * кадрах сделала сама панель. Нет `claude` в PATH — съёмка не начинается (код 2).
 *
 * Запуск: node tools/help-shots/panel-agent-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5216), GUIDE_WEB_PORT (8926), GUIDE_LANG (ru|en),
 *             GUIDE_ONLY (first | guards), GUIDE_HOLD=1 — поднять стенд и ждать.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT, openScenario, applyShotLanguage } from './kit.mjs';
import { dropLinkedStand, makeLinkedStand } from './linked-stand.mjs';
import { shootFirst, shootGuards } from './panel-agent-scenes.mjs';
import { panelAgentShotsProgram } from './panel-agent-model.mjs';
import { cliDir, STUB_PROFILE } from '../qa/panel-agent-core-stand.mjs';
import { DEFAULT_CORE_STUBS, freePort, reapCoreSessions } from '../qa/throwaway-stand.mjs';
import { HOP_RECORD_ENV, listenerPid, watchHops } from '../../apps/server/src/lib/hop-recorder.mjs';
import { startPanelAgentModel } from '../../packages/stub-model/src/scenarios/panel-agent.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5216);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8926);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/** Сосед репозитория, а не %TEMP%: путь попадает в кадр, имени человека в нём быть не должно. */
export const STAND = join(dirname(REPO_ROOT), 'claude-demo-panel-agent');
const CONFIG_DIR = join(STAND, '.claude');
const HOME_DIR = join(STAND, 'home');
const CORE_HOME = join(STAND, 'core-home');
const HOP_FILE = join(STAND, 'core-hops.json');
/**
 * Настоящий каталог — во временной папке ОС, рядом лишь соединение на него
 * (`linked-stand.mjs`): иначе ворота «решает только человек» отбивали
 * `PATCH /api/settings` съёмки 403.
 */
const TEMP_PREFIX = 'cc-help-panel-agent-';
const STUB_KEY = 'help-shots-stub-key';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function makeStand(modelUrl) {
  makeLinkedStand(STAND, TEMP_PREFIX, 'tools/help-shots/panel-agent-panel.mjs');
  mkdirSync(join(CONFIG_DIR, 'agentdeck'), { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(join(STAND, 'shop'), { recursive: true });
  mkdirSync(CORE_HOME, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'settings.json'), json({}), 'utf8');
  writeFileSync(
    join(CONFIG_DIR, 'CLAUDE.md'),
    '# Правила\n\n## Коротко о главном\n\nСначала план, потом правка.\n',
    'utf8',
  );
  // Реестр маршрутов ядро строит при загрузке из state.json панели — профиль кладётся до старта.
  writeFileSync(
    join(CONFIG_DIR, 'agentdeck', 'state.json'),
    json({
      projects: [],
      settings: {
        onboardingDone: true,
        theme: 'light',
        language: 'ru',
        provider: 'claude',
        // Шлюз и DLP-прокси по умолчанию слушают 5179 — порт живого стенда человека.
        platformGateway: { enabled: false, port: await freePort(), forceStream: true },
        dlp: {
          enabled: false,
          port: await freePort(),
          upstreamUrl: '',
          upstreamProfileId: '',
          passUnknown: false,
          journal: true,
        },
        endpointProfiles: [
          {
            id: STUB_PROFILE,
            name: 'Stub',
            baseUrl: modelUrl,
            apiKind: 'anthropic',
            model: 'stub-model',
            writeToken: false,
            imagesUrl: '',
            ownerPlatformId: '',
          },
        ],
        assistantEndpointId: STUB_PROFILE,
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(CORE_HOME, 'config.json'),
    json({ routes: { stub: DEFAULT_CORE_STUBS } }),
    'utf8',
  );
}

function dropStand() {
  dropLinkedStand(STAND, TEMP_PREFIX);
}

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

/** PATH панели и ядра: настоящий `claude` человека и системный минимум. */
function standPath(claudeDir) {
  const parts = [claudeDir];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    parts.push(join(root, 'System32'), 'C:\\Program Files\\Git\\cmd');
  } else {
    parts.push('/usr/bin', '/bin');
  }
  return parts.join(delimiter);
}

const claudeDir = cliDir('claude');
if (!claudeDir) {
  console.log('Не проверено: claude нет в PATH — ход агента через ядро без CLI не снять.');
  process.exit(2);
}

const model = await startPanelAgentModel(panelAgentShotsProgram);
const started = [];
let hops;
await makeStand(model.baseUrl);

try {
  // Ключ PATH на Windows пишется как угодно (`Path`), а два варианта в одном
  // окружении дочерний процесс разбирает непредсказуемо — оставляем один.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  const env = {
    ...inherited,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
    PATH: standPath(claudeDir),
    AGENTDECK_OPEN_BROWSER: '0',
    // Ядро стенда поднимает съёмка сама: надзор панели выключен, иначе в том же доме встало бы
    // второе ядро. Дом ядра общий у панели (прокладка) и ядра; итог записи звеньев — файл сторожа.
    AGENTDECK_CORE_SUPERVISE: '0',
    AGENTDECK_CORE_HOME: CORE_HOME,
    [HOP_RECORD_ENV]: HOP_FILE,
    AGENTDECK_PANEL_DATA: join(CONFIG_DIR, 'agentdeck'),
  };
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
    { env, stdio: 'ignore', shell: false, cwd: REPO_ROOT },
  );
  started.push(server);
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);
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
        cwd: join(REPO_ROOT, 'apps', 'web'),
        env: { ...process.env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 120))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  // Ядро — после панели и фронта: сторож звеньев записывает их pid, ядро доверяет им тем же
  // путём, что у `dev-watch`.
  hops = watchHops({
    coreHome: CORE_HOME,
    pidsOf: () => [server.pid, listenerPid(WEB_PORT)],
    file: HOP_FILE,
    everyMs: 300,
  });
  await hops.refresh();
  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'src/index.ts', '--home', CORE_HOME],
      { cwd: join(REPO_ROOT, 'apps', 'core'), env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/core/health`, 90)))
    throw new Error('ядро одноразового стенда не поднялось');
  console.log('ядро поднято');
  // Ключ заглушки — в хранилище панели; запись пускается только с Origin фронта.
  const token = await fetch(`${PANEL}/api/endpoints/${STUB_PROFILE}/token`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: WEB },
    body: JSON.stringify({ token: STUB_KEY }),
  });
  if (token.status !== 200) throw new Error(`ключ заглушки: HTTP ${token.status}`);

  if (process.env.GUIDE_HOLD) {
    console.log('стенд поднят, Ctrl+C — снести');
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
  } else {
    const browser = await chromium.launch();
    const context = { panel: PANEL, stand: STAND, configDir: CONFIG_DIR };
    const only = process.env.GUIDE_ONLY ?? '';
    const broken = [];
    const run = async (name, shoot) => {
      if (only && only !== name) return;
      const scenario = openScenario('panelAgent', name);
      console.log(`\nсценарий panelAgent/${name}`);
      try {
        await shoot(browser, WEB, scenario, context);
      } catch (error) {
        broken.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`  ОТКАЗ: ${error instanceof Error ? error.stack : String(error)}`);
      }
      scenario.finish();
    };
    try {
      await run('first', shootFirst);
      await run('guards', shootGuards);
    } finally {
      await browser.close();
    }
    if (broken.length) {
      console.log(`\nсценариев с отказом: ${broken.length}`);
      for (const line of broken) console.log(`  ${line}`);
      process.exitCode = 1;
    }
  }
} finally {
  hops?.stop();
  for (const child of started) child.kill();
  // Процесс сервера держит файлы стенда ещё мгновение после сигнала; хосты сессий ядра
  // отвязаны от ядра и снимаются по своему журналу.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  reapCoreSessions(CORE_HOME);
  await model.close();
  try {
    dropStand();
  } catch (error) {
    console.log(`стенд не снесён: ${error instanceof Error ? error.message : String(error)}`);
  }
}
