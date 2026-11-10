/**
 * Кадры справки «Чат» → «Окно сайта и выбор элемента» (этап 12, D20): `chat/site`.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель, своё ядро. Сайт — тот же
 * поддельный dev-сервер, что у проверок (`domains/site-preview/__fixtures__/dev-site.mjs`), запущенный
 * настоящим реестром запусков панели; окно сайта, прокси и маскировка выбора — настоящие. Модель
 * кадрам не нужна: снимаются полоса, окно с подсветкой и чип в поле ввода, сообщение не уходит.
 *
 * Кадры:
 *   01-pane — полоса «Сайт: stand-site» над лентой и окно сайта справа, «Выбрать элемент»
 *             нажата, вторая кнопка подсвечена;
 *   02-chip — чип выбранного элемента над полем ввода.
 *
 * Варианты кадра (тема × язык) — одним прогоном: язык и тема — настройкой панели с перезагрузкой.
 * Запуск: node tools/help-shots/chat-site-preview.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import {
  DEFAULT_MASKS,
  REPO_ROOT,
  SHOT_VARIANTS,
  applyShotLanguage,
  openScenario,
} from './kit.mjs';

const FIXTURE = 'apps/server/src/domains/site-preview/__fixtures__/dev-site.mjs';
// Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один.
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
// Ядру нужен найденный CLI, чтобы стенд поднялся; сам CLI кадрам не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;
const L = {
  ru: { pick: 'Выбрать элемент', ask: 'Сделай эту кнопку заметнее' },
  en: { pick: 'Pick an element', ask: 'Make this button stand out' },
};

let site = '';
const stand = await startStand({
  label: 'chat-site-help-shots',
  core: true,
  fakeCli: { claude: FAKE_CLAUDE },
  seed: ({ root }) => {
    site = join(root, 'stand-site');
    mkdirSync(site, { recursive: true });
    copyFileSync(join(REPO_ROOT, FIXTURE), join(site, 'dev-site.mjs'));
    writeFileSync(
      join(site, 'package.json'),
      `${JSON.stringify({ name: 'stand-site', private: true, scripts: { dev: 'node dev-site.mjs' } }, null, 2)}\n`,
    );
  },
});

/** Окно «нужен доступ» (у стенда нет входа в CLI) закрывает страницу — закрыть его Escape. */
async function closeAccessDialog(page) {
  const blocking = page.getByRole('dialog').filter({ hasText: /нужен доступ|needs access/ });
  await blocking
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  if (!(await blocking.count())) return;
  await page.keyboard.press('Escape');
  await blocking
    .first()
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined);
}

async function shootVariant(page, variant) {
  const t = L[variant.lang];
  const scenario = openScenario('chat', 'site', variant.lang, variant.theme);
  await applyShotLanguage(stand.apiUrl, variant.lang, variant.theme);
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    ([lang, theme]) =>
      document.documentElement.lang.startsWith(lang) &&
      document.documentElement.dataset.theme === theme,
    [variant.lang, variant.theme],
    { timeout: 90_000 },
  );
  await page.locator('textarea[data-chat-input]').waitFor({ timeout: 90_000 });
  await closeAccessDialog(page);

  await page.locator('[data-site-open]').click();
  const pane = page.locator('[data-site-preview]');
  await pane.waitFor({ timeout: 20_000 });
  const frame = page.frameLocator('[data-site-preview] iframe');
  const second = frame.locator('button.buy').nth(1);
  await second.waitFor({ timeout: 20_000 });
  await pane.getByRole('button', { name: t.pick }).click();
  await second.hover();
  await wait(600);
  await scenario.shot(page, '01-pane', { maskText: MASKS });

  await second.click();
  await page.locator('[data-composer-chip]').waitFor({ timeout: 15_000 });
  await page.locator('textarea[data-chat-input]').fill(t.ask);
  await page.mouse.move(2, 2);
  await wait(500);
  await scenario.shot(page, '02-chip', {
    clip: 'xpath=//*[@data-composer-chips]/../..',
    padding: 16,
    maskText: MASKS,
  });
  scenario.finish();
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const added = await stand.api('/projects', {
    method: 'POST',
    body: { path: site, name: 'stand-site' },
  });
  if (added.status >= 300) throw new Error(`проект не добавился: ${added.text}`);
  const started = await stand.api('/project-runner/start', {
    method: 'POST',
    body: { path: site },
  });
  if (started.status !== 200) throw new Error(`сайт не запустился: ${started.text}`);
  for (let i = 0; i < 60; i++) {
    const runs = (await stand.api('/project-runner')).body;
    const run = (Array.isArray(runs) ? runs : []).find(
      (r) => r.projectPath.toLowerCase() === site.toLowerCase(),
    );
    if (run?.status === 'running' && run.url) break;
    await wait(500);
  }

  const page = await stand.newPage(browser, { width: 1500, height: 900 });
  await page.addInitScript(
    ({ path }) => {
      const tabId = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      localStorage.setItem(
        'agentdeck:workspace',
        JSON.stringify({
          projectTabs: [{ id: tabId, path, name: 'stand-site' }],
          activeTabId: tabId,
          views: {},
        }),
      );
      localStorage.setItem('agentdeck.localModelHint.dismissed', '1');
    },
    { path: site },
  );
  for (const variant of SHOT_VARIANTS) {
    console.log(`\nвариант ${variant.key}`);
    await shootVariant(page, variant);
  }
  if (page.errors.length) console.log(`ошибки страницы: ${page.errors.join(' | ')}`);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await stand
    .api('/project-runner/stop', { method: 'POST', body: { path: site } })
    .catch(() => undefined);
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
