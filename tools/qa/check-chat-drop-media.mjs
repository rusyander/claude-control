/**
 * Файл, брошенный в поле чата в режиме «Картинка», не прикладывается скрыто
 * (ревью 28.09, F-140). В режимах картинки и презентации чипов вложений нет, и
 * брошенный файл висел невидимым, а уходил со следующим обычным сообщением.
 *
 * Позитив: в режиме «Сообщение» брошенный файл ложится чипом — так видно, что
 * бросок вообще доходит до поля. Негатив: в «Картинке» бросок ничего не
 * прикладывает — вернувшись в «Сообщение», чипа нет. Ничего не отправляется:
 * любая запись к API — 501, CLI не запускается.
 *
 * Запуск: `node tools/qa/check-chat-drop-media.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/chat-drop/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/chat-drop';
mkdirSync(SHOTS, { recursive: true });

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

/** Бросок файла на поле ввода: те же dragover и drop, что шлёт браузер. */
async function dropFile(page, name) {
  const box = page.locator('main textarea').first();
  const transfer = await page.evaluateHandle((fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(['qa'], fileName, { type: 'text/plain' }));
    return data;
  }, name);
  await box.dispatchEvent('dragover', { dataTransfer: transfer });
  await box.dispatchEvent('drop', { dataTransfer: transfer });
  await page.waitForTimeout(400);
}

const chipOf = (page, name) => page.getByRole('button', { name: `Удалить: ${name}` });

async function pickMode(page, label) {
  await page.locator('main [aria-haspopup="dialog"][title^="Режим отправки"]').first().click();
  const menu = page.getByRole('dialog', { name: 'Что сделает отправка' });
  await menu.waitFor({ timeout: 10_000 });
  const item = menu.getByRole('button', { name: new RegExp(`^${label}`) });
  const enabled = await item.isEnabled();
  if (enabled) await item.click();
  else await page.keyboard.press('Escape');
  return enabled;
}

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  const blocked = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  // Рисовать на стенде может быть нечем (нет разговора, контура, ключа) —
  // проверяется бросок, а не рисование: план картинки подменён доступным.
  await page.route(/\/api\/media\/images\/plan(\?.*)?$/, (route) =>
    route.fulfill({
      json: { available: true, source: 'agent', title: 'Агент разговора', model: '' },
    }),
  );
  await bypassOnboarding(page);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.locator('main textarea').first().waitFor({ timeout: 60_000 });

  await dropFile(page, 'qa-text-mode.txt');
  check(
    await chipOf(page, 'qa-text-mode.txt').isVisible(),
    `${theme}: в «Сообщении» брошенный файл — чипом`,
  );
  await chipOf(page, 'qa-text-mode.txt')
    .click()
    .catch(() => undefined);

  // Режим медиа, какой есть на стенде: картинке нужен источник, презентации — нет.
  const media = (await pickMode(page, 'Картинка'))
    ? 'Картинка'
    : (await pickMode(page, 'Презентация'))
      ? 'Презентация'
      : undefined;
  const image = Boolean(media);
  check(image, `${theme}: режим медиа доступен на стенде`, media ?? 'ни картинки, ни презентации');
  if (image) {
    await dropFile(page, 'qa-image-mode.txt');
    await page.screenshot({ path: `${SHOTS}/image-mode-drop-${theme}_${PHASE}.png` });
    await pickMode(page, 'Сообщение');
    const hidden = await chipOf(page, 'qa-image-mode.txt').isVisible();
    check(
      !hidden,
      `${theme}: брошенное в «Картинке» не приложено скрыто`,
      hidden ? 'чип появился в «Сообщении»' : '',
    );
    await page.screenshot({ path: `${SHOTS}/back-to-text-${theme}_${PHASE}.png` });
  }
  check(blocked.length === 0, `${theme}: записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
