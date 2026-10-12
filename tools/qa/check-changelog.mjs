/**
 * Вкладка «Что нового» в «Истории изменений» на живом стенде (`pnpm dev`, :8888).
 *
 * Ответ `/api/changelog` подменён своей лентой (`page.route`): проверка не зависит
 * от истории репозитория и ничего на стенде не пишет. Подмена только у границы —
 * сама страница, вкладки, фокус и ключи настоящие. Сервер и git проверяют
 * `apps/server/src/domains/changelog/*.test.ts`.
 *
 * Строки таблицы — то, что проверено; ненулевой код выхода — любое расхождение.
 * Снимки кладутся в `.agent/screenshots/changelog/`.
 *
 * Запуск: node tools/qa/check-changelog.mjs   (браузеры: pnpm qa:setup)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = join('.agent', 'screenshots', 'changelog');
mkdirSync(SHOTS, { recursive: true });

// Один настоящий PNG 1×1: адреса снимков отвечают им, чтобы картинки грузились.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const rows = [];
const check = (name, ok, detail = '') => {
  rows.push({ name, ok: Boolean(ok), detail: String(detail) });
};

const text = (ru, en) => ({ ru, ...(en ? { en } : {}) });
const counts = (files, insertions, deletions) => ({ files, insertions, deletions });
const commit = (n, subject) => ({
  hash: `${n}`.padStart(40, 'a'),
  shortHash: `${n}`.padStart(8, 'a'),
  date: '2026-10-12T10:00:00+05:00',
  subject,
  body: 'Подробности коммита:\n- первая строка\n- вторая строка',
  ...counts(3, 40, 5),
});

/** Лента подмены: выпуск в работе со снимками, описанный выпуск, автозаписи из git. */
function stubEntries(extraGit = 25) {
  const asset = (name) => `/api/changelog/assets/2026-10-12-stub-tab/${name}`;
  const entries = [
    {
      id: '2026-10-12-stub-tab',
      source: 'curated',
      status: 'pending',
      date: '2026-10-12T12:00:00.000Z',
      kind: 'added',
      title: text('Вкладка «Что нового»', "What's new tab"),
      summary: text('Лента выпусков панели со свежим сверху.', 'A feed of panel releases.'),
      items: [
        {
          kind: 'added',
          text: text('Аккордеон выпуска', 'Release accordion'),
          how: text('Шапка — одна кнопка.', 'The header is one button.'),
          area: text('История', 'History'),
          images: [asset('thumb.png')],
        },
        { kind: 'fixed', text: text('Исправлен сбор числа строк'), images: [] },
        { kind: 'internal', text: text('Тест на настоящем git'), images: [] },
      ],
      images: [
        { url: asset('before.png'), role: 'before', caption: text('До', 'Before') },
        { url: asset('after.png'), role: 'after', caption: text('После', 'After') },
      ],
      links: [{ label: text('Запрос на слияние'), url: 'https://example.com/mr/1' }],
      commits: [],
      areas: [],
      totals: counts(0, 0, 0),
    },
    {
      id: 'working-tree',
      source: 'tree',
      status: 'pending',
      date: '2026-10-12T12:30:00.000Z',
      kind: 'changed',
      title: text('working-tree'),
      items: [],
      images: [],
      links: [],
      commits: [],
      areas: [
        { area: 'web', files: 6, insertions: 700, deletions: 20 },
        { area: 'server', files: 4, insertions: 300, deletions: 10 },
      ],
      totals: counts(10, 1000, 30),
    },
    {
      id: '2026-10-11-stub-released',
      source: 'curated',
      status: 'released',
      date: '2026-10-11T10:00:00+05:00',
      kind: 'improved',
      title: text('Выпущенное описание с числами'),
      items: [{ kind: 'improved', text: text('Числа из коммитов'), images: [] }],
      images: [],
      links: [],
      commits: [commit(1, 'feat: вкладка'), commit(2, 'fix: подсчёт')],
      areas: [
        { area: 'web', files: 6, insertions: 700, deletions: 20 },
        { area: 'server', files: 4, insertions: 300, deletions: 10 },
        { area: 'tests', files: 3, insertions: 120, deletions: 0 },
        { area: 'docs', files: 1, insertions: 3, deletions: 1 },
      ],
      totals: counts(14, 1123, 31),
    },
    {
      id: '2026-10-10-stub-old',
      source: 'curated',
      status: 'released',
      date: '2026-10-10T09:00:00+05:00',
      kind: 'improved',
      title: text('Прошлый описанный выпуск'),
      items: [{ kind: 'improved', text: text('Быстрее список'), images: [] }],
      images: [],
      links: [],
      commits: [commit(3, 'perf: список')],
      areas: [{ area: 'web', files: 1, insertions: 10, deletions: 2 }],
      totals: counts(1, 10, 2),
    },
  ];
  for (let i = 0; i < extraGit; i += 1) {
    const kind = i % 3 === 0 ? 'fixed' : i % 3 === 1 ? 'docs' : 'internal';
    entries.push({
      id: `git-${String(i).padStart(8, '0')}`,
      source: 'git',
      status: 'released',
      date: `2026-09-${String(28 - (i % 27)).padStart(2, '0')}T10:00:00+05:00`,
      kind,
      title: text(`Правка из git ${i}`),
      items: i % 2 ? [{ kind, text: text(`Пункт ${i}`), images: [] }] : [],
      images: [],
      links: [],
      commits: [commit(100 + i, `fix: правка ${i}`)],
      areas: [{ area: 'server', files: 1, insertions: 5, deletions: 1 }],
      totals: counts(1, 5, 1),
    });
  }
  return entries;
}

async function open(browser, { response, viewport, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1280, height: 900 },
    colorScheme,
  });
  const page = await context.newPage();
  await bypassOnboarding(page);
  await page.route('**/api/changelog/assets/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
  await page.route(/\/api\/changelog(\?.*)?$/, (route) => {
    if (typeof response === 'function') return response(route);
    return route.fulfill({
      json: response ?? { entries: stubEntries(), gitAvailable: true, invalid: [] },
    });
  });
  return { context, page };
}

const headers = (page) => page.locator('button[data-changelog-entry]');
const expandedOf = async (page, index) =>
  (await headers(page).nth(index).getAttribute('aria-expanded')) === 'true';

const browser = await chromium.launch();
try {
  // ── 1. Вкладки и раскрытие ────────────────────────────────────────────────
  {
    const { context, page } = await open(browser);
    await page.goto(`${BASE}/history`, { waitUntil: 'domcontentloaded' });
    await headers(page).first().waitFor({ timeout: 20000 });

    const changelogTab = page.getByRole('tab', { name: /Что нового/ });
    check(
      '/history без ?tab открывается на «Что нового»',
      (await changelogTab.getAttribute('aria-selected')) === 'true',
    );
    check(
      'первая вкладка в полосе — «Что нового»',
      (await page.getByRole('tab').first().innerText()).includes('Что нового'),
    );

    const total = await headers(page).count();
    check('показаны 20 выпусков из 29 (первая страница)', total === 20, `показано ${total}`);
    check('первый выпуск раскрыт', await expandedOf(page, 0));
    check('остальные свёрнуты', !(await expandedOf(page, 1)) && !(await expandedOf(page, 5)));
    check(
      'выпуск в работе помечен «Не опубликовано», автозапись — «Из git»',
      (await page.getByText('Не опубликовано').count()) === 1 &&
        (await page.getByText('Из git', { exact: true }).count()) >= 1,
    );

    await headers(page).nth(1).click();
    check(
      'щелчок раскрывает второй выпуск, первый остаётся',
      (await expandedOf(page, 1)) && (await expandedOf(page, 0)),
    );
    await headers(page).nth(0).click();
    check(
      'щелчок по первому сворачивает только его',
      !(await expandedOf(page, 0)) && (await expandedOf(page, 1)),
    );

    await headers(page).nth(2).focus();
    await page.keyboard.press('Enter');
    const byEnter = await expandedOf(page, 2);
    await page.keyboard.press('Space');
    const bySpace = !(await expandedOf(page, 2));
    check(
      'Enter раскрывает, пробел сворачивает',
      byEnter && bySpace,
      `enter=${byEnter} space=${bySpace}`,
    );

    await page.getByRole('button', { name: 'Развернуть все' }).click();
    const allOpen =
      (await page.locator('button[data-changelog-entry][aria-expanded="true"]').count()) === total;
    await page.getByRole('button', { name: 'Свернуть все' }).click();
    const noneOpen =
      (await page.locator('button[data-changelog-entry][aria-expanded="true"]').count()) === 0;
    check(
      '«Развернуть все» / «Свернуть все»',
      allOpen && noneOpen,
      `all=${allOpen} none=${noneOpen}`,
    );

    // Снова первый — для тела: пункты, «Как», полоса областей, коммиты, ссылки.
    await headers(page).first().click();
    const body = page.getByRole('region').first();
    // Описание без коммита чисел не несёт: ни полосы областей, ни коммитов, ни «+N −M».
    check(
      'описание в работе: без чисел, полосы областей и коммитов',
      (await headers(page).first().innerText()).match(/[+−]\d/) === null &&
        (await body.getByRole('img', { name: /Веб:/ }).count()) === 0 &&
        (await body.getByRole('button', { name: /Коммиты/ }).count()) === 0,
    );
    check(
      'в теле: пункты по видам',
      (await body.getByText('Аккордеон выпуска').count()) === 1 &&
        (await body.getByText('Исправлен сбор числа строк').count()) === 1,
    );
    check(
      'в теле: строка «Как:»',
      (await body.getByText('Как: Шапка — одна кнопка.').count()) === 1,
    );
    // Карточка правок рабочей копии: свой заголовок, пометка и числа; видов нет.
    const treeHeader = page.locator('button[data-changelog-entry="working-tree"]');
    check(
      'правки рабочей копии: заголовок, пометка и числа',
      (await treeHeader.innerText()).includes('Незакоммиченные правки') &&
        (await treeHeader.innerText()).includes('Рабочая копия') &&
        (await treeHeader.innerText()).includes('+1\u00a0000') &&
        !(await treeHeader.innerText()).includes('Добавлено'),
      (await treeHeader.innerText()).replaceAll('\n', ' | '),
    );
    await treeHeader.click();
    const treeBody = page.getByRole('region').nth(1);
    check(
      'правки рабочей копии: пояснение и полоса областей',
      (await treeBody.getByText(/Все правки рабочей копии/).count()) === 1 &&
        (await treeBody.getByRole('img', { name: /Веб: \+700/ }).count()) === 1,
    );
    await treeHeader.click();
    // Выпущенное описание: числа и области берутся из его коммитов.
    await headers(page).nth(2).click();
    const released = page.getByRole('region').last();
    check(
      'в теле выпущенного: полоса областей и легенда',
      (await released.getByRole('img', { name: /Веб: \+700/ }).count()) === 1 &&
        (await released.getByText('Сервер', { exact: true }).count()) >= 1,
    );
    check(
      'в теле: ссылка открывается в новой вкладке безопасно',
      (await body.locator('a[target="_blank"][rel~="noopener"]').count()) === 1,
    );
    await released.getByRole('button', { name: /Коммиты \(2\)/ }).click();
    check(
      'коммиты раскрываются, у хэша есть «Скопировать»',
      (await released.getByText('feat: вкладка').count()) === 1 &&
        (await released.getByText(/Подробности коммита/).count()) === 2 &&
        (await released.getByRole('button', { name: /Скопировать хэш/ }).count()) === 2,
    );

    // Снимок: окно открывается, Escape закрывает, фокус возвращается на миниатюру.
    const thumb = body.getByRole('button', { name: /Открыть снимок: Аккордеон выпуска/ });
    await thumb.click();
    const dialog = page.getByRole('dialog');
    check(
      'щелчок по миниатюре открывает окно со снимком',
      (await dialog.locator('img').count()) === 1,
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    const focusedBack = await thumb.evaluate((el) => el === document.activeElement);
    check(
      'Escape закрывает окно, фокус возвращается на миниатюру',
      (await page.getByRole('dialog').count()) === 0 && focusedBack,
    );

    // Фильтры.
    await page.getByRole('button', { name: 'Описанные', exact: true }).click();
    check(
      'источник «Описанные» оставляет только описанные (3)',
      (await headers(page).count()) === 3,
      `показано ${await headers(page).count()}`,
    );
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await page.getByRole('button', { name: /^Исправлено/ }).click();
    const fixed = await headers(page).count();
    check(
      'чип «Исправлено» оставляет записи с этим видом',
      fixed > 0 && fixed < 20,
      `показано ${fixed}`,
    );
    await page.getByRole('button', { name: 'Описанные', exact: true }).click();
    const bothActive = await headers(page).count();
    check(
      'источник и вид сужают вместе (описанный с «Исправлено» — один)',
      bothActive === 1,
      `показано ${bothActive}`,
    );
    // Отбор, под который ничего не подходит: «Документация» выбрана при «Все»,
    // потом источник сужен до описанных, где такого вида нет.
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await page.getByRole('button', { name: /^Исправлено/ }).click();
    await page.getByRole('button', { name: /^Документация/ }).click();
    await page.getByRole('button', { name: 'Описанные', exact: true }).click();
    check(
      'пустой отбор — сообщение и «Сбросить фильтры»',
      (await page.getByText('Под выбранные фильтры ничего не подошло').count()) === 1,
    );
    await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
    check('«Сбросить фильтры» возвращает ленту', (await headers(page).count()) === 20);

    // Страница 2.
    await page.getByRole('button', { name: /Показать ещё 9/ }).click();
    check(
      '«Показать ещё» добавляет остаток (29), кнопка исчезает',
      (await headers(page).count()) === 29 &&
        (await page.getByRole('button', { name: /Показать ещё/ }).count()) === 0,
    );

    // Клавиатура на полосе вкладок.
    await changelogTab.focus();
    await page.keyboard.press('ArrowRight');
    await page
      .getByText('Что это', { exact: true })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => undefined);
    check(
      'стрелка вправо переключает на «Настройки», адрес получает ?tab=config',
      page.url().includes('tab=config') &&
        (await page.getByText('Что это', { exact: true }).count()) >= 1,
      page.url(),
    );
    await context.close();
  }

  // ── 2. Переход по ?id= на выпуск за первой страницей ─────────────────────
  {
    const { context, page } = await open(browser);
    await page.goto(`${BASE}/history?tab=changelog&id=git-00000023`, {
      waitUntil: 'domcontentloaded',
    });
    const target = page.locator('button[data-changelog-entry="git-00000023"]');
    await target.waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    const inView = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight;
    });
    check(
      '?id= показывает выпуск дальше первой страницы, раскрытым и в окне',
      (await target.getAttribute('aria-expanded')) === 'true' && inView,
      `inView=${inView}`,
    );
    await context.close();
  }

  // ── 3. Особые ответы ─────────────────────────────────────────────────────
  {
    const { context, page } = await open(browser, {
      response: {
        entries: stubEntries(0).slice(3),
        gitAvailable: false,
        invalid: [{ file: '2026-10-11-bad.json', error: 'items: Too small' }],
      },
    });
    await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
    await headers(page).first().waitFor({ timeout: 20000 });
    check(
      'без git — строка «История git недоступна»',
      (await page.getByText(/История git недоступна/).count()) === 1,
    );
    check(
      'битый файл назван, остальные показаны',
      (await page.getByText('2026-10-11-bad.json').count()) === 1 &&
        (await headers(page).count()) === 1,
    );
    await context.close();
  }
  {
    const { context, page } = await open(browser, {
      response: { entries: [], gitAvailable: true, invalid: [] },
    });
    await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Пока ничего нет').waitFor({ timeout: 20000 });
    check(
      'пустая лента — пояснение, без панели фильтров',
      (await page.getByRole('button', { name: 'Описанные', exact: true }).count()) === 0,
    );
    await context.close();
  }
  {
    let calls = 0;
    const { context, page } = await open(browser, {
      response: (route) => {
        calls += 1;
        if (calls <= 2) return route.fulfill({ status: 500, json: { error: 'boom' } });
        return route.fulfill({
          json: { entries: stubEntries(2), gitAvailable: true, invalid: [] },
        });
      },
    });
    await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
    const retry = page.getByRole('button', { name: /Повторить/ });
    await retry.waitFor({ timeout: 30000 });
    await retry.click();
    await headers(page).first().waitFor({ timeout: 20000 });
    check(
      'сбой загрузки — карточка с «Повторить», после неё лента',
      (await headers(page).count()) >= 2,
      `запросов ${calls}`,
    );
    await context.close();
  }

  // ── 4. Телефон: без горизонтальной прокрутки ─────────────────────────────
  {
    const { context, page } = await open(browser, { viewport: { width: 400, height: 800 } });
    await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
    await headers(page).first().waitFor({ timeout: 20000 });
    await headers(page).nth(2).click();
    await page.getByRole('button', { name: /Коммиты \(2\)/ }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('на 400 px страница не уходит вбок', overflow <= 0, `лишних px: ${overflow}`);
    await page.screenshot({ path: join(SHOTS, 'changelog-phone.png') });
    await context.close();
  }

  // ── 5. Снимки в обеих темах ──────────────────────────────────────────────
  for (const scheme of ['light', 'dark']) {
    const { context, page } = await open(browser, { colorScheme: scheme });
    await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
    await headers(page).first().waitFor({ timeout: 20000 });
    await headers(page).nth(2).click();
    await page.getByRole('button', { name: /Коммиты \(2\)/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `changelog-${scheme}.png`) });
    check(`снимок вкладки, тема ${scheme}`, true, `changelog-${scheme}.png`);
    await context.close();
  }
} catch (error) {
  check('сценарий дошёл до конца', false, String(error.message).split('\n')[0]);
} finally {
  await browser.close();
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = rows.filter((r) => !r.ok);
console.log(
  `\n${rows.length - failed.length}/${rows.length} строк сошлись, расхождений: ${failed.length}`,
);
process.exit(failed.length ? 1 : 0);
