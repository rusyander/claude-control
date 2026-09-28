/**
 * Окна страницы рядом с пристёгнутым окном агента (ревью Z5-11/12/13).
 *
 * Широкий экран, окно агента открыто. Проверяет:
 * - командная палитра встаёт слева от окна агента, а не поверх: окно агента
 *   остаётся доступным (не aria-hidden) и принимает клик;
 * - колесо над затемнением не прокручивает страницу под ним;
 * - закрыли окно агента его же кнопкой — фокус уходит в открытое окно страницы,
 *   а не на body (кнопка агента лежит в недоступной странице).
 * Живой стенд (:8888); запросов на запись не шлёт.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await bypassOnboarding(page);
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

const rows = [];
const check = (ok, label) => {
  rows.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}`);
};
const shot = async (name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

try {
  // Страница длиннее экрана — иначе прокручивать под затемнением нечего.
  await page.goto(`${BASE}/skills`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 30000 });
  await page.waitForTimeout(800);

  await page.locator('[data-panel-agent-trigger]').click();
  const agentWindow = page.locator('[data-panel-agent-window]');
  await agentWindow.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(400);

  // Фокус на странице: Ctrl+K — глобальное сочетание.
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('combobox', { name: 'Командная палитра' });
  await palette.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(400);
  await shot('palette-with-dock');

  const geometry = await page.evaluate(() => {
    const dock = document.querySelector('[data-panel-agent-window]')?.getBoundingClientRect();
    const panel = document
      .querySelector('[role="combobox"][aria-label="Командная палитра"]')
      ?.closest('[role="dialog"]')
      ?.getBoundingClientRect();
    return dock && panel ? { dockLeft: dock.left, panelRight: panel.right } : null;
  });
  check(
    geometry !== null && geometry.panelRight <= geometry.dockLeft,
    `палитра слева от окна агента (${JSON.stringify(geometry)})`,
  );
  const hidden = await agentWindow.evaluate(
    (el) => el.closest('[aria-hidden="true"]') !== null || el.closest('[inert]') !== null,
  );
  check(!hidden, 'окно агента не скрыто от доступности под палитрой');
  const hit = await page.evaluate(() => {
    const input = document.querySelector('[data-panel-agent-window] [data-agent-input]');
    if (!input) return false;
    const box = input.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top !== null && input.contains(top);
  });
  check(hit, 'поле окна агента принимает клик под открытой палитрой');

  // Z5-11: колесо над затемнением слева.
  const scrollers = () =>
    page.evaluate(() =>
      [document.scrollingElement, ...document.querySelectorAll('main, main *')]
        .filter((el) => el && el.scrollHeight > el.clientHeight + 1)
        .map((el) => el.scrollTop),
    );
  const before = await scrollers();
  await page.mouse.move(150, 850);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(400);
  const after = await scrollers();
  check(
    JSON.stringify(before) === JSON.stringify(after),
    `колесо над затемнением не двигает страницу (${JSON.stringify(before)} → ${JSON.stringify(after)})`,
  );

  // Z5-12: окно агента закрыли его кнопкой — фокус остаётся в палитре.
  await agentWindow.locator('button[aria-label="Закрыть"]').first().click({ timeout: 3000 });
  await page.waitForTimeout(400);
  const focusIn = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'body';
    return active.closest('[role="dialog"]') ? 'dialog' : active.tagName;
  });
  check(focusIn === 'dialog', `после закрытия окна агента фокус в открытом окне (${focusIn})`);
  await shot('palette-after-dock-closed');
  await page.keyboard.press('Escape');
} catch (error) {
  check(false, `сценарий оборвался: ${error.message}`);
} finally {
  await browser.close();
}

if (problems.length) console.log(`ОШИБКИ СТРАНИЦЫ: ${problems.slice(0, 3).join(' | ')}`);
const ok = rows.every(Boolean) && problems.length === 0;
console.log(ok ? 'ИТОГ: зелёный' : 'ИТОГ: КРАСНЫЙ');
process.exit(ok ? 0 : 1);
