/**
 * Кадры путеводителей «Проекты» и «Группы»: четыре сценария одной съёмкой.
 *
 * Разделы сняты вместе потому, что у них один стенд и одни данные: группа
 * привязывается к проекту из того же реестра, а собственный `.claude` проекта
 * человек видит и на вкладке проекта, и на карточке привязанной группы. Держать
 * два стенда значило бы держать две копии этих данных, которые однажды
 * разойдутся.
 *
 * Сценарии делятся ПО ВХОДУ, а не по объёму:
 *
 *   projects/setup — папка становится проектом, и у неё появляются свои
 *                    правила, MCP-серверы и права;
 *   projects/local — в репозитории УЖЕ есть свой `.claude`: что из него видно
 *                    и почему панель его не правит;
 *   groups/bundle  — набор под задачу, который включают руками;
 *   groups/auto    — то же, но чтобы включалось само: привязка к проекту,
 *                    порядок работы и сценарий-автоматизация.
 *
 * ПАНЕЛЬ ОДНОРАЗОВАЯ: каталог конфигурации во временной папке, свои порты, свой
 * фронт. Рабочий стенд не трогается, настоящий `~/.claude` не читается.
 * Подменяются только ОТВЕТЫ сервера (`page.route`), как в `tools/qa/check-*.mjs`:
 * настоящий прогон потребовал бы репозитория на диске, установленного CLI и
 * записи групп в живую конфигурацию. Ни одного экрана, которого нет в панели,
 * здесь не выдумано.
 *
 * Запуск: node tools/help-shots/projects-panel.mjs
 * Переменные: GUIDE_PANEL_PORT (5195), GUIDE_WEB_PORT (8905),
 *             GUIDE_ONLY — снять один сценарий (setup|local|bundle|auto).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario, applyShotLanguage } from './kit.mjs';
import { shootSetup } from './projects-setup.mjs';
import { shootLocal } from './projects-local.mjs';
import { shootBundle } from './groups-bundle.mjs';
import { shootAuto } from './groups-auto.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5195);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8905);
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

const SCENARIOS = [
  { only: 'setup', topic: 'projects', name: 'setup', shoot: shootSetup },
  { only: 'local', topic: 'projects', name: 'local', shoot: shootLocal },
  { only: 'bundle', topic: 'groups', name: 'bundle', shoot: shootBundle },
  { only: 'auto', topic: 'groups', name: 'auto', shoot: shootAuto },
];

const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-projects-guide-'));
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
