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
 *                        устарела, секрет MCP, отказ при чужом CLI и при
 *                        сломанных правилах маскирования.
 *
 * СТЕНД ОДНОРАЗОВЫЙ: `CLAUDE_CONFIG_DIR` и домашний каталог уводятся в каталог
 * рядом с репозиторием и сносятся в конце. Личный `~/.claude` не читается.
 *
 * ПОДМЕНЕНА ТОЛЬКО МОДЕЛЬ. На PATH панели лежит фальшивый `claude`
 * (`panel-agent-fake-cli.mjs`): панель запускает его своим маршрутом, он
 * поднимает НАСТОЯЩИЙ переходник `tools/mcp/panel.mjs` и зовёт действия панели.
 * Карточки, диффы, исходы, след действий и файлы разговоров в кадрах сделала
 * сама панель; по сценарию сыграна лишь реплика модели. Страница не подменяет
 * ни одного ответа сервера.
 *
 * Запуск: node tools/help-shots/panel-agent-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5216), GUIDE_WEB_PORT (8926), GUIDE_LANG (ru|en),
 *             GUIDE_ONLY (first | guards), GUIDE_HOLD=1 — поднять стенд и ждать.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT, openScenario, applyShotLanguage } from './kit.mjs';
import { shootFirst, shootGuards } from './panel-agent-scenes.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5216);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8926);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/** Сосед репозитория, а не %TEMP%: путь попадает в кадр, имени человека в нём быть не должно. */
export const STAND = join(dirname(REPO_ROOT), 'claude-demo-panel-agent');
const CONFIG_DIR = join(STAND, '.claude');
const HOME_DIR = join(STAND, 'home');
const BIN_DIR = join(STAND, 'bin');
const MARK = '.help-shots-owned';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function makeStand() {
  if (existsSync(STAND) && !existsSync(join(STAND, MARK))) {
    throw new Error(`${STAND} уже существует и создан не съёмкой`);
  }
  rmSync(STAND, { recursive: true, force: true });
  mkdirSync(join(CONFIG_DIR, 'agentdeck'), { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(join(STAND, 'shop'), { recursive: true });
  writeFileSync(join(STAND, MARK), 'создан tools/help-shots/panel-agent-panel.mjs\n', 'utf8');
  writeFileSync(join(CONFIG_DIR, 'settings.json'), json({}), 'utf8');
  writeFileSync(
    join(CONFIG_DIR, 'CLAUDE.md'),
    '# Правила\n\n## Коротко о главном\n\nСначала план, потом правка.\n',
    'utf8',
  );
  writeFileSync(
    join(CONFIG_DIR, 'agentdeck', 'state.json'),
    json({
      projects: [],
      settings: { onboardingDone: true, theme: 'light', language: 'ru', provider: 'claude' },
    }),
    'utf8',
  );
  // Фальшивый CLI: `claude.cmd` на Windows, исполняемый `claude` в остальных.
  const script = join(REPO_ROOT, 'tools', 'help-shots', 'panel-agent-fake-cli.mjs');
  if (process.platform === 'win32') {
    writeFileSync(
      join(BIN_DIR, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    writeFileSync(
      join(BIN_DIR, 'claude'),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      {
        mode: 0o755,
      },
    );
  }
}

function dropStand() {
  if (existsSync(join(STAND, MARK))) rmSync(STAND, { recursive: true, force: true });
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

/**
 * PATH панели: фальшивый CLI и системный минимум. Настоящий `claude` лежит рядом
 * с node, поэтому каталог node в PATH не попадает — фальшивый зовёт node по
 * абсолютному пути.
 */
function standPath() {
  const parts = [BIN_DIR];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    parts.push(join(root, 'System32'), 'C:\\Program Files\\Git\\cmd');
  } else {
    parts.push('/usr/bin', '/bin');
  }
  return parts.join(delimiter);
}

const started = [];
makeStand();

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
    PATH: standPath(),
    CC_FAKE_SEEN: join(STAND, 'model-saw.jsonl'),
  };
  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { env, stdio: 'ignore', shell: false, cwd: REPO_ROOT },
    ),
  );
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
  for (const child of started) child.kill();
  // Процесс сервера держит файлы стенда ещё мгновение после сигнала.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    dropStand();
  } catch (error) {
    console.log(`стенд не снесён: ${error instanceof Error ? error.message : String(error)}`);
  }
}
