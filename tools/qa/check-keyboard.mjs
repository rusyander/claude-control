/**
 * Клавиатурный обход всех разделов панели: то, чего axe не видит.
 *
 * По каждому разделу на живом стенде (`pnpm dev`, :8888):
 *  1. Tab по кругу — порядок фокуса, видимость кольца фокуса, ловушки
 *     (фокус застрял на одном элементе), досягаемость навигации и содержимого.
 *  2. Модалка создания (где кнопка ведёт в модалку): открывается с клавиатуры,
 *     Escape закрывает, фокус возвращается на кнопку.
 *  3. Enter на ссылке навигации в другой раздел ведёт туда.
 *
 * Список остановок каждого раздела складывается в `.agent/tmp/a11y/<раздел>.focus.json`,
 * чтобы порядок можно было прочитать глазами, а не только по итогу.
 * Ненулевой код выхода — ловушка, недосягаемое содержимое, модалка без
 * возврата фокуса или невидимый фокус на интерактивном элементе.
 *
 * Запуск: node tools/qa/check-keyboard.mjs   (браузеры: pnpm qa:setup)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { PANEL_PAGES, findCreateButton, openPanelPage, pageSlug } from './panel-pages.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const REPORT_DIR = join('.agent', 'tmp', 'a11y');
mkdirSync(REPORT_DIR, { recursive: true });

/** Сколько Tab максимум на раздел: длинные списки не должны длиться вечно. */
const MAX_TABS = 400;

/** Снимок текущего фокуса: что это, где оно и видно ли кольцо. */
const snapshot = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const label = (
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    el.textContent ||
    ''
  )
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 50);
  const path = [];
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const index = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) : 0;
    path.push(`${node.tagName.toLowerCase()}:${index}`);
  }
  // Кольцо фокуса: outline либо box-shadow на самом элементе. Поле ввода
  // может рисовать обводку контейнером (`.box:focus-within`, как композер
  // чата) — тогда кольцом считается рамка или тень контейнера, который
  // держит :focus-within. Оба «none» на элементе с фокусом от клавиатуры —
  // фокус невидим.
  const hasRing = (style) =>
    (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none';
  const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  const container = el.parentElement;
  const containerStyle = container ? getComputedStyle(container) : null;
  const containerRing =
    isField &&
    containerStyle !== null &&
    container.matches(':focus-within') &&
    (hasRing(containerStyle) ||
      (containerStyle.borderStyle !== 'none' && containerStyle.borderWidth !== '0px'));
  const ring = hasRing(cs) || containerRing;
  return {
    key: path.join('>'),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    label,
    visible: rect.width > 0 && rect.height > 0,
    ring,
    inNav: Boolean(el.closest('nav')),
    inMain: Boolean(el.closest('main')),
    inDialog: Boolean(el.closest('[role="dialog"]')),
  };
};

async function sweep(page) {
  const stops = [];
  const seen = new Set();
  let leftToBody = 0;
  let repeats = 0;
  let trap = null;

  for (let i = 0; i < MAX_TABS; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(snapshot);
    if (!stop) {
      leftToBody += 1;
      if (leftToBody >= 2) break; // круг замкнулся через адресную строку
      continue;
    }
    const last = stops.at(-1);
    repeats = last && last.key === stop.key ? repeats + 1 : 0;
    if (repeats >= 3) {
      trap = stop;
      break;
    }
    if (seen.has(stop.key) && i > 3) break; // вернулись к началу — обход завершён
    seen.add(stop.key);
    stops.push(stop);
  }
  return { stops, trap, exhausted: stops.length >= MAX_TABS };
}

/** Модалка создания с клавиатуры: Enter открывает, Escape закрывает, фокус возвращается. */
async function checkDialog(page) {
  const create = await findCreateButton(page);
  if (!create) return { note: 'нет кнопки создания', problem: null };
  await create.focus();
  await page.keyboard.press('Enter');
  const box = page.locator('[role="dialog"]').first();
  const opened = await box.waitFor({ state: 'visible', timeout: 2500 }).then(
    () => true,
    () => false,
  );
  // Кнопка без модалки (создаёт сразу, раскрывает строку) — не дефект, просто
  // нечего проверять; отмечаем, чтобы отчёт не выглядел как «всё проверено».
  if (!opened) return { note: 'кнопка создания без модалки', problem: null };
  await page.waitForTimeout(300);
  const inside = await page.evaluate(snapshot);
  const focusInside = Boolean(inside?.inDialog);
  await page.keyboard.press('Escape');
  const closed = await box.waitFor({ state: 'hidden', timeout: 2500 }).then(
    () => true,
    () => false,
  );
  await page.waitForTimeout(400); // анимация закрытия — фокус возвращается после неё
  const returned = closed && (await create.evaluate((el) => el === document.activeElement));
  const note = `модалка: фокус внутри ${focusInside ? 'да' : 'НЕТ'}, Escape ${closed ? 'закрывает' : 'НЕ закрывает'}, фокус ${returned ? 'вернулся' : 'НЕ вернулся'}`;
  return { note, problem: focusInside && closed && returned ? null : note };
}

/** Enter на ссылке навигации, ведущей в ДРУГОЙ раздел, меняет адрес. */
async function checkNavEnter(page, path) {
  const hrefs = await page
    .locator('nav a[href]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  const index = hrefs.findIndex((href) => href && href !== path);
  if (index < 0) return { note: 'нет ссылок навигации в другие разделы', problem: null };
  const before = page.url();
  await page.locator('nav a[href]').nth(index).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const moved = page.url() !== before;
  const note = moved
    ? 'Enter по ссылке навигации ведёт дальше'
    : 'Enter по ссылке навигации НЕ ведёт дальше';
  return { note, problem: moved ? null : note };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await bypassOnboarding(page);

const problems = [];
const summary = [];

for (const entry of PANEL_PAGES) {
  const { path, name } = entry;
  await openPanelPage(page, BASE, entry);

  const { stops, trap, exhausted } = await sweep(page);
  const ringless = stops.filter((s) => s.visible && !s.ring);
  const lines = [];
  if (stops.length === 0) lines.push('фокус не попадает ни на один элемент');
  if (trap) lines.push(`ловушка фокуса: ${trap.tag} «${trap.label}»`);
  if (!stops.some((s) => s.inNav)) lines.push('навигация недосягаема с клавиатуры');
  if (!stops.some((s) => s.inMain)) lines.push('содержимое раздела недосягаемо с клавиатуры');
  for (const s of ringless.slice(0, 4)) {
    lines.push(`фокус невидим: ${s.tag}${s.role ? `[${s.role}]` : ''} «${s.label}»`);
  }
  if (ringless.length > 4) lines.push(`… и ещё ${ringless.length - 4} без кольца фокуса`);

  const dialog = await checkDialog(page);
  if (dialog.problem) lines.push(dialog.problem);
  const nav = await checkNavEnter(page, path);
  if (nav.problem) lines.push(nav.problem);

  writeFileSync(
    join(REPORT_DIR, `${pageSlug(path)}.focus.json`),
    JSON.stringify(
      { path, name, stops, trap, exhausted, dialog: dialog.note, navigation: nav.note },
      null,
      2,
    ),
  );

  const status = lines.length === 0 ? 'ок' : 'ПРОБЛЕМЫ';
  const tail = exhausted ? ` (обход оборван на ${MAX_TABS})` : '';
  summary.push(
    `${name} (${path}): остановок ${stops.length}${tail}, в навигации ${stops.filter((s) => s.inNav).length}, в содержимом ${stops.filter((s) => s.inMain).length}, без кольца ${ringless.length}; ${dialog.note} — ${status}`,
  );
  for (const line of lines) problems.push(`[${name}] ${line}`);
}

await browser.close();

console.log(summary.join('\n'));
if (problems.length > 0) {
  console.log(`\nПроблемы (${problems.length}):\n  · ${problems.join('\n  · ')}`);
  process.exit(1);
}
console.log('\nКлавиатурный обход чист.');
