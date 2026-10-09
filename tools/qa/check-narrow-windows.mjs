/**
 * Кейс layout-003: два окна боковой панели на телефоне (400×800), в светлой и
 * тёмной теме — окно агента панели и окно фонового наблюдателя.
 *
 * Обход устойчивости окон (`check-modal-stability.mjs`) и обходы доступности их
 * не видят: оба окна — не общий `Modal`, а открываются кнопками свёрнутой боковой
 * панели. Здесь каждое открывается так, как это сделал бы человек с телефона, и
 * проверяется то, что он увидел бы:
 *  - окно целиком в экране (ни края за пределами 400×800), страница не уехала
 *    вбок (нет горизонтальной прокрутки);
 *  - кнопки свёрнутой панели не показывают обрезанных подписей («У», «А» у края);
 *  - Escape закрывает окно и возвращает фокус на кнопку, которая его открыла.
 *
 * Стенд — живой (`pnpm dev`, :8888), только чтение: тема подменяется в ответе
 * GET /api/settings, наблюдатель — подменённым статусом, любая запись к серверу
 * заглушена 501. `SHOTS=<каталог>` — снимки обоих окон в обеих темах.
 *
 * Запуск: `node tools/qa/check-narrow-windows.mjs`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { waitForStand } from './modal-box.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const VIEW = { width: 400, height: 800 };

const rows = [];
const check = (ok, text, detail = '') => {
  rows.push({ ok, text });
  console.log(`${ok ? 'ок    ' : 'ПЛОХО ×'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

if (!(await waitForStand(BASE))) {
  console.log(`НЕ ПРОВЕРЕНО: стенд ${BASE} не ответил`);
  process.exit(2);
}

/** Статус включённого наблюдателя: окно и строка видны только при нём. */
function watcherStatus() {
  const now = new Date().toISOString();
  return {
    enabled: true,
    since: new Date(Date.now() - 95_000).toISOString(),
    serverNow: now,
    analyzing: false,
    pending: 1,
    findings: 3,
    remarks: 1,
    thresholds: { slowRequestMs: 5000, stuckLoadingMs: 30000 },
    hourlyCap: { limit: 12, used: 2 },
    spend: { input: 1840, output: 410, cacheRead: 12600, cacheCreation: 900, runs: 2 },
    reportPath: 'C:/qa/WATCH-REPORT.md',
  };
}

/** Коробка элемента против экрана и ширина документа. */
async function fits(page, locator) {
  const box = await locator.boundingBox();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const inside =
    box !== null &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= VIEW.width + 0.5 &&
    box.y + box.height <= VIEW.height + 0.5;
  return {
    ok: inside && scrollWidth <= VIEW.width,
    text: box
      ? `${Math.round(box.width)}×${Math.round(box.height)}@${Math.round(box.x)},${Math.round(box.y)}, ширина документа ${scrollWidth}`
      : 'коробки нет',
  };
}

/** Видимый текст кнопки свёрнутой панели: подпись там — обрезок у края. */
const peek = (locator) =>
  locator.evaluate((button) => {
    const nav = button.closest('nav')?.getBoundingClientRect();
    const range = document.createRange();
    let visible = '';
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && nav && rect.left < nav.right) visible += node.textContent.trim();
    }
    return visible;
  });

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: VIEW, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await bypassOnboarding(page);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        return route.fulfill({ status: 501, json: { error: 'check: writes stubbed' } });
      }
      const url = new URL(request.url());
      if (url.pathname === '/api/settings') {
        const response = await route.fetch();
        const body = await response.json();
        // Этот перехват — последний и отменяет обход мастера из bypassOnboarding:
        // на стенде, где онбординг не пройден, мастер накрывал окно агента.
        return route.fulfill({ response, json: { ...body, theme, onboardingDone: true } });
      }
      if (url.pathname === '/api/watcher') return route.fulfill({ json: watcherStatus() });
      return route.fallback();
    });

    // ── Агент панели ────────────────────────────────────────────────────────
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    check(applied === theme, `[${theme}] тема применена`, applied);
    const notify = page.locator('nav button[aria-label="Уведомления"]').first();
    const agentTrigger = page.locator('[data-panel-agent-trigger]').first();
    const watcherTrigger = page.locator('[data-watcher-indicator]:not([data-watcher-off])').first();
    for (const [name, button] of [
      ['уведомления', notify],
      ['агент панели', agentTrigger],
      ['наблюдатель', watcherTrigger],
    ]) {
      const text = (await button.count()) ? await peek(button) : '';
      check(
        text === '',
        `[${theme}] свёрнутая панель: у кнопки «${name}» нет обрезка подписи`,
        text,
      );
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${theme}-rail.png`) });

    // Палец — на значок: кнопка шире свёрнутой панели, её середину накрывает страница.
    await agentTrigger.click({ position: { x: 20, y: 20 } });
    const agent = page.locator('[data-panel-agent-window]').first();
    const agentOpen = await agent
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check(agentOpen, `[${theme}] окно агента панели открылось`);
    if (agentOpen) {
      await page.waitForTimeout(600);
      const box = await fits(page, agent);
      check(box.ok, `[${theme}] окно агента целиком в экране 400×800`, box.text);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${theme}-panel-agent.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      check(!(await agent.isVisible()), `[${theme}] Escape закрыл окно агента`);
      check(
        await agentTrigger.evaluate((el) => el === document.activeElement),
        `[${theme}] фокус вернулся на кнопку агента`,
      );
    }

    // ── Фоновый наблюдатель ─────────────────────────────────────────────────
    const hasWatcher = await watcherTrigger
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check(hasWatcher, `[${theme}] строка наблюдателя видна (статус подменён)`);
    if (hasWatcher) {
      await watcherTrigger.click({ position: { x: 20, y: 20 } });
      const popover = page.locator('[data-watcher-popover]').first();
      const popoverOpen = await popover
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      check(popoverOpen, `[${theme}] окно наблюдателя открылось`);
      if (popoverOpen) {
        await page.waitForTimeout(600);
        const box = await fits(page, popover);
        check(box.ok, `[${theme}] окно наблюдателя целиком в экране 400×800`, box.text);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${theme}-watcher.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        check(!(await popover.isVisible()), `[${theme}] Escape закрыл окно наблюдателя`);
        check(
          await watcherTrigger.evaluate((el) => el === document.activeElement),
          `[${theme}] фокус вернулся на строку наблюдателя`,
        );
      }
    }
    check(errors.length === 0, `[${theme}] страница без необработанных ошибок`, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}

const bad = rows.filter((row) => !row.ok).length;
console.log(`\nитог: строк ${rows.length}, расхождений ${bad}`);
process.exit(bad > 0 ? 1 : 0);
