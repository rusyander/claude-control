/**
 * Кадры «Фонового наблюдателя» в документе «Настройки»: `settings/watcher`,
 * русские и английские за один прогон.
 *
 * СТЕНД ОДНОРАЗОВЫЙ: конфигурация Claude, домашний каталог и сам отчёт
 * наблюдателя — во временном каталоге, который в конце удаляется. Личный
 * `~/.claude` владельца машины не читается и не правится.
 *
 * НЕ ПОДМЕНЯЕТСЯ НИ ОДИН ОТВЕТ ПАНЕЛИ. Подменена только модель: на PATH лежит
 * фальшивый `claude`, который отвечает находкой в формате разборщика, — время,
 * расход и число находок в кадре панель посчитала сама. Сбой, который попадает
 * в отчёт, — настоящая ошибка страницы, брошенная из таймера.
 *
 * Путь отчёта в кадре заменён нейтральным: настоящий — временный каталог
 * машины съёмки с именем её пользователя.
 *
 * Запуск: node tools/help-shots/settings-watcher.mjs
 * Переменные: GUIDE_PANEL_PORT (5287), GUIDE_WEB_PORT (8987).
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { REPO_ROOT, SHOT_LANGS, applyShotLanguage, openScenario } from './kit.mjs';
import {
  openSettingsTab,
  openSection,
  patchSettings,
  shotCard,
} from './access-providers-fixture.mjs';

const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5287);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8987);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const IS_WIN = process.platform === 'win32';
const CARD = '[data-watcher-card]';
const SHOWN_REPORT_PATH = '…/agentdeck/WATCH-REPORT.md';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* ещё не поднялось */
    }
    await wait(500);
  }
  return false;
}

async function watcher(body) {
  const res = await fetch(`${PANEL}/api/watcher`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

/** Фальшивый `claude`: одна находка на каждый сбой из промпта, расход — как у настоящего. */
function writeFakeClaude(bin, root) {
  const script = join(root, 'fake-claude.mjs');
  writeFileSync(
    script,
    `const argv = process.argv.slice(2);
if (!argv.includes('-p')) process.exit(0);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const ids = [...prompt.matchAll(/^id: ([0-9a-f]+)$/gm)].map((m) => m[1]);
  const findings = ids.map((id) => ({ id, title: 'Settings page threw', happened: 'Timer callback threw.', rootCause: 'Items read before load.', steps: 'Open Settings.', verdict: 'confirmed', severity: 'high', location: 'apps/web/src/pages/Settings/GeneralTab.tsx:1', fix: 'Catch it.' }));
  if (ids.length) findings.push({ kind: 'remark', title: 'Timer is never cleared', explanation: 'The timeout outlives the page.', severity: 'low', location: 'apps/web/src/pages/Settings/GeneralTab.tsx:1', fix: 'Clear it on unmount.', relatedTo: ids[0] });
  const fence = String.fromCharCode(96).repeat(3);
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: fence + 'agentdeck-watch\\n' + JSON.stringify(findings) + '\\n' + fence, modelUsage: { 'claude-haiku-4-5': { inputTokens: 1840, outputTokens: 410, cacheReadInputTokens: 12600, cacheCreationInputTokens: 900 } } }) + '\\n');
});
`,
    'utf8',
  );
  if (IS_WIN) {
    writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    const shim = join(bin, 'claude');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    chmodSync(shim, 0o755);
  }
}

/**
 * Остановить ровно тот процесс, что запущен здесь, по его записанному PID —
 * без `taskkill /T`: обход дерева идёт по PID родителя, которые Windows не
 * чистит, и однажды снёс чужой стенд владельца. Потомок esbuild у Vite
 * выходит сам, когда закрывается его канал к Vite.
 */
function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

async function shoot(browser, scenario, reportFile) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  try {
    await watcher({ enabled: false });
    // Отчёт прошлого языка убирается: выключенная карточка без находок — та,
    // которую человек видит до первого включения.
    rmSync(reportFile, { force: true });
    // ── 01. Выключенный ──────────────────────────────────────────────────────
    await openSettingsTab(page, WEB, 'general', 2500);
    await shotCard(scenario, page, '01-card-off', CARD);

    // ── 02. Включённый после первого сбоя ────────────────────────────────────
    // Включает тумблер карточки — тот же путь, что у человека.
    await page.locator(`${CARD} [role="switch"]`).click();
    await page.waitForSelector('[data-watcher-indicator]');
    await wait(3500); // опрос статуса взвёл сбор ошибок страницы
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('Cannot read properties of undefined (reading "items")');
      }, 0);
    });
    for (let i = 0; i < 40; i += 1) {
      const status = await watcher();
      if (status.findings >= 1 && status.spend.runs >= 1 && !status.analyzing) break;
      await wait(500);
    }
    await wait(3500); // карточка перечитала статус
    await page.evaluate((shown) => {
      for (const node of document.querySelectorAll('[data-watcher-report-path]')) {
        node.textContent = shown;
      }
    }, SHOWN_REPORT_PATH);
    await shotCard(scenario, page, '02-card-on', CARD);

    // ── 03. Индикатор и его окно ─────────────────────────────────────────────
    // «Правила» пустого стенда, а не «Обзор»: обзор печатает каталог
    // конфигурации, то есть временный путь машины съёмки.
    await openSection(page, WEB, '/rules', 2500);
    await page.locator('[data-watcher-indicator]').click();
    await page.waitForSelector('[data-watcher-popover]');
    await wait(400);
    await scenario.shot(page, '03-indicator');
    await page.keyboard.press('Escape');
    await watcher({ enabled: false });
  } finally {
    await page.close();
  }
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-watcher-shots-')));
const home = join(root, 'home');
const cfg = join(home, '.claude');
const bin = join(root, 'bin');
for (const dir of [cfg, bin, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');
writeFakeClaude(bin, root);

const system = IS_WIN
  ? [
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      process.env.SystemRoot ?? 'C:\\Windows',
    ]
  : ['/usr/bin', '/bin'];
const homeEnv = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: cfg,
  APPDATA: join(home, 'AppData/Roaming'),
  LOCALAPPDATA: join(home, 'AppData/Local'),
};
const base = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['PATH', ...Object.keys(homeEnv)].includes(key.toUpperCase()),
  ),
);
const reportFile = join(root, 'report', 'WATCH-REPORT.md');
const started = [];
let exitCode = 0;
try {
  started.push(
    spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], {
      cwd: join(REPO_ROOT, 'apps/server'),
      env: {
        ...base,
        ...homeEnv,
        PATH: [bin, ...system].join(IS_WIN ? ';' : ':'),
        PORT: String(PANEL_PORT),
        WEB_PORT: String(WEB_PORT),
        AGENTDECK_WATCH_REPORT: reportFile,
        AGENTDECK_WATCH_DEBOUNCE_MS: '300',
      },
      stdio: 'ignore',
      shell: false,
    }),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
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
        cwd: join(REPO_ROOT, 'apps/web'),
        env: { ...process.env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 120))) throw new Error('фронт одноразовой панели не поднялся');
  await patchSettings(PANEL, { onboardingDone: true, theme: 'light' });

  const browser = await chromium.launch();
  try {
    for (const lang of SHOT_LANGS) {
      await applyShotLanguage(PANEL, lang);
      const scenario = openScenario('settings', 'watcher', lang);
      console.log(`\nсценарий settings/watcher [${lang}]`);
      await shoot(browser, scenario, reportFile);
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  for (const child of started) stopChild(child);
  await wait(600);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(exitCode);
