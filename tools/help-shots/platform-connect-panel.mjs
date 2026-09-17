/**
 * Кадры путеводителя «Контур», сторона ПАНЕЛИ: все сценарии одной съёмкой.
 *
 * Панель поднимается СВОЯ, одноразовая: каталог конфигурации во временной
 * папке, свои порты, свой фронт. Рабочий стенд человека не трогается — ни его
 * контуры, ни его ассистент, ни его конфигурации CLI. Тот же приём, что в
 * `tools/qa/check-platform-foreign.mjs`.
 *
 * Сценарии идут путём человека, потому что каждый опирается на состояние,
 * оставленное предыдущим: подключение → активация с пробным запросом →
 * маршрут → правила → агент → режимы → сценарный контур → удаление.
 * Живой контур — локальный стенд платформы компании через `kubectl port-forward
 * svc/inst-api 5300:8080`, ключ — файлом из
 * `PLATFORM_STAND_KEY_FILE` / `PLATFORM_STAND_KEY_VAR` (не печатается). Сценарный — `tools/qa/stub-platform.mjs` (см.
 * `platform-scripted-panel.mjs`, зачем он и что в нём подменено).
 *
 * `finish()` зовётся только после ПОЛНОСТЬЮ удачной съёмки: он удаляет кадры
 * своей стороны, не снятые этим прогоном, и упавшая на середине съёмка
 * стёрла бы честные кадры прошлой.
 *
 * Запуск: node tools/help-shots/platform-connect-panel.mjs   (GUIDE_LANG=en — английские)
 * Переменные: PLATFORM_API, PLATFORM_MODEL, PLATFORM_STAND_KEY_FILE, PLATFORM_STAND_KEY_VAR, GUIDE_PANEL_PORT, GUIDE_WEB_PORT, GUIDE_STUB_PORT,
 * GUIDE_HEADED=1; отладка упавшей съёмки — GUIDE_KEEP, GUIDE_REUSE, GUIDE_STEPS (ниже).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { applyShotLanguage, openScenario } from './kit.mjs';
import { LANG } from './platform-shots-lib.mjs';
import {
  shootActivate,
  shootAgent,
  shootConnect,
  shootDelete,
  shootMedia,
  shootRoute,
  shootRules,
} from './platform-stand-panel.mjs';
import { shootScripted } from './platform-scripted-panel.mjs';

const CONTOUR_URL = process.env.PLATFORM_API ?? 'http://127.0.0.1:5300';
const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5192);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8899);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const SCENARIOS = ['connect', 'activate', 'route', 'rules', 'agent', 'media', 'scripted'];

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
 * Отладка съёмки: `GUIDE_KEEP=1` оставляет панель жить после падения,
 * `GUIDE_REUSE=1 GUIDE_STEPS=scripted,delete` продолжает на ней с упавшего
 * шага. Кадры такой съёмки честные, но опись дочищается только у снятых ею
 * сценариев.
 */
const KEEP = process.env.GUIDE_KEEP === '1';
const REUSE = process.env.GUIDE_REUSE === '1';
const ONLY = (process.env.GUIDE_STEPS ?? '').split(',').filter(Boolean);

const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-guide-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');
let ok = false;

try {
  if (!REUSE) await startPanel();
  await applyShotLanguage(PANEL, LANG);
  const shots = Object.fromEntries(SCENARIOS.map((id) => [id, openScenario('platform', id)]));
  const browser = await chromium.launch({ headless: process.env.GUIDE_HEADED !== '1' });
  const ran = new Set();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const ctx = { page, web: WEB, panel: PANEL, shots, contourUrl: CONTOUR_URL };
    const steps = [
      ['connect', shootConnect],
      ['activate', shootActivate],
      ['route', shootRoute],
      ['rules', shootRules],
      ['agent', shootAgent],
      ['media', shootMedia],
      ['scripted', shootScripted],
      ['delete', shootDelete],
    ];
    for (const [name, step] of steps) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      console.log(`— ${name}`);
      try {
        await step(ctx);
      } catch (error) {
        // Кадр места падения: без него причину пришлось бы угадывать по тексту ошибки.
        const shot = join(tmpdir(), 'cc-guide-fail.png');
        await page.screenshot({ path: shot }).catch(() => {});
        console.log(`упало на «${name}», экран: ${shot}`);
        throw error;
      }
      ran.add(name);
    }
  } finally {
    await browser.close();
  }
  // Удаление дописывает кадр в «connect»: без съёмки самого «connect» его
  // опись не дочищается, иначе кадры 09–17 считались бы неснятыми.
  for (const id of SCENARIOS) if (ran.has(id)) shots[id].finish();
  ok = true;
} finally {
  if (REUSE || ok || !KEEP) {
    // При REUSE `started` пуст, а `home` — своя пустая папка этого запуска.
    for (const child of started) child.kill();
    rmSync(home, { recursive: true, force: true });
  } else {
    for (const child of started) child.unref();
    console.log(`панель оставлена: ${WEB}, дом ${home}`);
  }
}

async function startPanel() {
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
      { env, stdio: 'ignore', shell: false, detached: KEEP },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

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
        detached: KEEP,
      },
    ),
  );
  if (!(await waitFor(WEB, 90))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);
}
