/**
 * Кадры путеводителя «Локальные модели»: два сценария одной съёмкой.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ: каталог конфигурации во временной папке, свои порты, свой
 * фронт. Подменяются только ответы `/api/local-models` (`page.route`): настоящий
 * раздел нашёл бы системный Ollama и при несовпадении контекста поднял бы его на
 * видеокарте владельца — съёмке это не нужно и недопустимо. Экран — настоящий,
 * подбор под карту и оценки страница считает сама.
 *
 * Запуск: node tools/help-shots/local-models-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5227), GUIDE_WEB_PORT (8937), GUIDE_ONLY (first).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { shootFirst } from './local-models-scenes.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5227);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8937);
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

const SCENARIOS = [{ only: 'first', topic: 'localModels', name: 'first', shoot: shootFirst }];

const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-local-models-guide-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');

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

  // Язык — до первого кадра и через настройки панели: кадр должен доказывать
  // тот путь, по которому язык приходит человеку. GUIDE_LANG=en → английские
  // кадры рядом с русскими.
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
  // иначе проверяется полным прогоном всех четырёх.
  const only = process.env.GUIDE_ONLY ?? '';
  try {
    for (const item of SCENARIOS) {
      if (only && only !== item.only) continue;
      const scenario = openScenario(item.topic, item.name);
      console.log(`\nсценарий ${item.topic}/${item.name}`);
      await item.shoot(browser, WEB, scenario);
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true });
}
