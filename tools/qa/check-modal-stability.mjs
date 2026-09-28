/**
 * Модальные окна не прыгают: коробка окна не меняется ни от чего, что
 * происходит внутри него.
 *
 * По каждому разделу `panel-pages.mjs` на живом стенде (`pnpm dev`, :8888):
 * окно, открытое обходом раздела (`interact`), или модалка создания (та же
 * кнопка, что жмут обходы доступности и клавиатуры). Коробка окна меряется
 * после каждого шага и сравнивается с первым замером:
 *  - открыто при придержанных ответах API (состояние загрузки) → ответы
 *    отданы (загружено);
 *  - каждая вкладка и переключатель внутри окна;
 *  - ввод неверного значения в первое поле и очистка (сообщения проверки);
 *  - подброшенное содержимое: тело в 3000px, пустое тело, тело шириной 4000px,
 *    строка ошибки. Это и делает вердикт независимым от данных стенда: судится
 *    оболочка окна, а не то, сколько записей у человека.
 * Всё, кроме GET, до сервера не доходит (`requestGuard`), GET только читает;
 * разделы, которым нужны свои данные (группы, правила), подменяют их сами.
 *
 * Ширины: 1440×900 и телефон 400×800 (там окно — лист во всю ширину).
 * Ненулевой код выхода — хоть одно окно сменило коробку. Раздел, чей обход не
 * дошёл до окна (стенд лёг трижды, кнопка открытия скрыта на узком экране),
 * печатается «не проверено» поимённо; '--strict' роняет прогон и на нём.
 *
 * `--mutant` подкладывает старую раскладку окна (высота по содержимому) —
 * проверка обязана покраснеть; зелёная с ним — значит, она ничего не ловит.
 *
 * Запуск: node tools/qa/check-modal-stability.mjs [--mutant] [--strict] [--json <файл>] [--only <часть пути>]
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { STUBBED } from './group-stubs.mjs';
import { PANEL_PAGES, findCreateButton, openPanelPage, pageSlug } from './panel-pages.mjs';
import {
  OLD_SIZING_CSS,
  boxText,
  dialogTitle,
  violations,
  measureDialog,
  requestGuard,
  topDialog,
  waitForStand,
} from './modal-box.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const argValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const JSON_OUT = argValue('--json');
const ONLY = argValue('--only');
const MUTANT = process.argv.includes('--mutant');
const STRICT = process.argv.includes('--strict');

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '400', width: 400, height: 800 },
];

/** Окно ошибки загрузки панели: стенд перезапускался, а не окно раздела. */
const STAND_DOWN_TITLE = 'Панель не загрузилась';

if (!(await waitForStand(BASE))) {
  console.log(`Стенд ${BASE} не ответил за 2 минуты — проверять нечего.`);
  process.exit(2);
}

const browser = await chromium.launch();
const rows = [];

/**
 * Окно одного раздела: уже открытое обходом (`interact`) либо модалка создания.
 * Возвращает null, если окна у раздела нет.
 */
async function openDialogOf(page, entry, guard) {
  // Подмены раздела (`prepare`) ставятся позже стража и перехватили бы запросы
  // первыми — страж ставится заново после них, чтобы запись не ушла мимо него.
  const wrapped = entry.prepare
    ? {
        ...entry,
        prepare: async (p) => {
          await entry.prepare(p);
          await guard.install(p);
        },
      }
    : entry;
  await openPanelPage(page, BASE, wrapped);
  const already = topDialog(page);
  if ((await already.count()) > 0) return { dialog: already, via: 'обход раздела' };
  if (entry.interact) return null;

  const create = await findCreateButton(page);
  if (!create) return null;
  guard.hold();
  await create.click({ timeout: 3000 }).catch(() => undefined);
  const dialog = topDialog(page);
  const shown = () =>
    dialog.waitFor({ state: 'visible', timeout: 2500 }).then(
      () => true,
      () => false,
    );
  let opened = await shown();
  // Окно, которое открывается только ПОСЛЕ ответа API, придержанным ответом не
  // дождаться: отпускаем и ждём ещё раз.
  if (!opened) {
    guard.release();
    opened = await shown();
  }
  if (!opened) return null;
  return { dialog, via: 'кнопка создания' };
}

/** Один раздел на одной ширине: строка отчёта, либо null — окна нет или уже измерено. */
async function checkEntry(context, entry, viewport, seen) {
  let lastError;
  // Стенд перезапускается под чужими правками: до трёх попыток, каждая в
  // свежей вкладке (одна вкладка на весь обход выдыхается, см. audit-layout.mjs).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await context.newPage();
    const guard = requestGuard({ stubbed: STUBBED });
    try {
      await bypassOnboarding(page);
      await guard.install(page);
      const found = await openDialogOf(page, entry, guard);
      if (!found) return null;
      const title = await dialogTitle(found.dialog);
      if (title === STAND_DOWN_TITLE) throw new Error('стенд не ответил');
      // Окно не общего `Modal` (всплывающая панель с ролью dialog) — не предмет проверки.
      const size = await found.dialog.getAttribute('data-modal-size');
      if (!size) return null;
      const key = entry.interact ? pageSlug(entry.path, entry.slug) : title;
      if (seen.has(key)) return null;
      const steps = await measureDialog(page, found.dialog, guard);
      seen.add(key);
      return { viewport: viewport.label, page: entry.name, title, size, via: found.via, steps };
    } catch (error) {
      lastError = error;
      await waitForStand(BASE);
    } finally {
      guard.release();
      await page.close().catch(() => undefined);
    }
  }
  return {
    viewport: viewport.label,
    page: entry.name,
    error: String(lastError?.message ?? lastError).split('\n')[0],
  };
}

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  if (MUTANT) {
    await context.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.dataset.modalMutant = '';
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, OLD_SIZING_CSS);
  }
  const seen = new Set();
  for (const entry of PANEL_PAGES) {
    if (ONLY && !entry.path.includes(ONLY)) continue;
    const row = await checkEntry(context, entry, viewport, seen);
    if (!row) continue;
    rows.push(row);
    const head = `[${viewport.label}] ${row.page}`;
    if (row.error) {
      console.log(`${head} — не проверено: ${row.error}`);
      continue;
    }
    const moved = violations(row);
    const verdict = moved.length
      ? `ПРЫГАЕТ: ${moved.map((s) => `${s.step} ${boxText(s)}`).join('; ')}`
      : `стоит (${row.steps.length} замеров)`;
    console.log(`${head} — «${row.title}» ${row.size} ${boxText(row.steps[0])} — ${verdict}`);
  }
  await context.close();
}

await browser.close();
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));

const measured = rows.filter((r) => r.steps);
const jumping = measured.filter((r) => violations(r).length > 0);
const failed = rows.filter((r) => r.error);
console.log(
  `\nОкон измерено: ${measured.length}, прыгают: ${jumping.length}, не проверено: ${failed.length}${MUTANT ? ' (мутант: старая раскладка)' : ''}.`,
);
if (measured.length === 0) {
  console.log('Ни одного окна не открылось — проверка ничего не доказала.');
  process.exit(1);
}
process.exit(jumping.length > 0 || (STRICT && failed.length > 0) ? 1 : 0);
