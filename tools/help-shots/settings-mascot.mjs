/**
 * Кадры раздела «Дека — маскот панели» в документе «Настройки»:
 * `settings/mascot`, русские и английские за один прогон; тёмная тема — тем же
 * скриптом с `GUIDE_THEME=dark`.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`): разговор засеян
 * транскриптом. Подменён ОДИН ответ — `GET /api/chat/awaiting`: без живого
 * агента иначе не сделать разговор ждущим (так же, как `tools/qa/check-mascot.mjs`).
 *
 * Запуск: node tools/help-shots/settings-mascot.mjs
 *         GUIDE_THEME=dark node tools/help-shots/settings-mascot.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { DEFAULT_MASKS, SHOT_LANGS, applyShotLanguage, openScenario, shotTheme } from './kit.mjs';
import { shotCard } from './access-providers-fixture.mjs';

const CHAT = 'help-mascot-chat';
/** Каталог стенда на обзоре — путь с именем пользователя машины съёмки. */
const MASKS = [...DEFAULT_MASKS, String.raw`[A-Za-z]:\\Users\\\S+`];
const TITLE = { ru: 'Починить вход в систему', en: 'Fix the sign-in flow' };
const CARD =
  'xpath=//*[@role="switch" and (@aria-label="Показывать Деку" or @aria-label="Show Decky")]' +
  '/ancestor::div[contains(@class,"padding-md")][1]';

function seed({ home, cfg }, lang) {
  const cwd = join(home, 'shop-frontend');
  mkdirSync(cwd, { recursive: true });
  const dir = join(cfg, 'projects', `shop-frontend-${lang}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${CHAT}-${lang}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      uuid: `${CHAT}-${lang}-u1`,
      sessionId: `${CHAT}-${lang}`,
      timestamp: new Date().toISOString(),
      cwd,
      message: { role: 'user', content: TITLE[lang] },
    })}\n`,
  );
}

const stand = await startStand({
  label: 'mascot-shots',
  settings: { theme: shotTheme() },
  seed: (paths) => SHOT_LANGS.forEach((lang) => seed(paths, lang)),
});

async function shoot(browser, scenario, lang) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 720 } });
  // Знакомство уже было: приветствие перекрыло бы реплику кадра.
  await context.addInitScript(() => {
    localStorage.setItem(
      'agentdeck.mascot',
      JSON.stringify({ enabled: true, chatty: true, greeted: true }),
    );
  });
  const page = await context.newPage();
  let asking = false;
  await page.route('**/api/chat/awaiting', (route) =>
    route.fulfill({
      json: {
        chats: asking
          ? [{ chatId: `${CHAT}-${lang}`, kind: 'question', askedAt: new Date().toISOString() }]
          : [],
      },
    }),
  );
  try {
    // ── 01. Разговор стал ждущим — реплика внизу боковой панели ──────────────
    await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-mascot-companion]', { timeout: 20_000 });
    await wait(2_000);
    asking = true;
    await page.waitForSelector('[data-mascot-speech="ask"]', { timeout: 15_000 });
    await page.mouse.move(700, 300);
    await wait(700);
    await scenario.shot(page, '01-ask', { maskText: MASKS });

    // ── 02. Сводка по клику ──────────────────────────────────────────────────
    await page.locator('[data-mascot-speech] button[aria-label]').last().click();
    await page.locator('[data-mascot-trigger]').click();
    await page.waitForSelector('[data-mascot-panel]');
    await wait(700);
    await scenario.shot(page, '02-panel', { maskText: MASKS });
    await page.keyboard.press('Escape');
    asking = false;

    // ── 03. Пустой чат ───────────────────────────────────────────────────────
    await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-mascot-greeting]', { timeout: 15_000 });
    // У стенда нет учётки Claude Code — чат открывает окно «нужен доступ».
    await wait(1_500);
    if ((await page.getByRole('dialog').count()) > 0) {
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').first().waitFor({ state: 'detached', timeout: 3_000 });
    }
    await wait(1_000);
    await shotCard(scenario, page, '03-chat', '[data-mascot-greeting]', 32);

    // ── 04. Карточка «Маскот» в «Общих» ──────────────────────────────────────
    await page.goto(`${stand.webUrl}/settings?tab=general`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(CARD);
    await wait(1_000);
    await shotCard(scenario, page, '04-settings', CARD);
  } finally {
    await context.close();
  }
}

let exitCode = 0;
try {
  const browser = await chromium.launch();
  try {
    for (const lang of SHOT_LANGS) {
      await applyShotLanguage(stand.apiUrl, lang);
      const scenario = openScenario('settings', 'mascot', lang);
      console.log(`\nсценарий settings/mascot [${lang}]`);
      await shoot(browser, scenario, lang);
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stand.stop();
}
process.exit(exitCode);
