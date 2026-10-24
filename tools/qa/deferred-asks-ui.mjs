// Настоящий интерфейс поверх живой проверки D-n (`check-group-deferred-asks.mjs`):
// тот же одноразовый стенд и его Vite, три зрителя — светлая и тёмная тема
// по-русски и светлая по-английски. Проверяет то, что видит человек, и снимает
// плашку, раздел хаба и карточку, ставшую D-n. Подмен нет: язык английского
// зрителя — его же ответ `/api/settings` с `language: 'en'`, остальное — сервер стенда.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const VARIANTS = [
  { name: 'light', colorScheme: 'light', lang: 'ru' },
  { name: 'dark', colorScheme: 'dark', lang: 'ru' },
  { name: 'en', colorScheme: 'light', lang: 'en' },
];

/** Подпись плашки на языке зрителя — по ней видно, что перевод дошёл. */
const BADGE = { ru: /Ждёт решения \(\d+\)/, en: /Awaiting decision \(\d+\)/ };
const CARD = { ru: /Отложено как D-\d+/, en: /Deferred as D-\d+/ };
/** Причина группы для человека; текст для агента («permission rows») в плашке — дефект. */
const REASON = {
  ru: 'Правила прав группы отдают этот вызов человеку.',
  en: "The group's permission rows send this call to a human.",
};

export async function openViewers(webUrl, shotsDir) {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const browser = await chromium.launch();
  const viewers = [];
  for (const variant of VARIANTS) {
    const context = await browser.newContext({
      viewport: { width: 1300, height: 900 },
      colorScheme: variant.colorScheme,
    });
    // Тема и язык — полями ответа сервера, как их выставил бы человек: тема
    // стенда может быть не «системной», и одна `colorScheme` её не переключает.
    await context.route(
      (url) => url.pathname === '/api/settings',
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        return route.fulfill({
          response,
          json: { ...body, language: variant.lang, theme: variant.colorScheme },
        });
      },
    );
    viewers.push({ ...variant, context, page: await context.newPage() });
  }
  const shot = async (viewer, name, locator) => {
    if (!shotsDir) return;
    const path = join(shotsDir, `${name}-${viewer.name}.png`);
    await (locator ?? viewer.page)
      .screenshot({ path })
      .catch(() => viewer.page.screenshot({ path }));
  };
  return {
    viewers,
    shot,
    close: () => browser.close().catch(() => undefined),
  };
}

/** Группа отложила вызов: плашка над разделом и раздел хаба родителя. */
export async function checkGroupUi(ui, webUrl, { parentChatId, id }, check) {
  for (const viewer of ui.viewers) {
    const { page } = viewer;
    await page.goto(`${webUrl}/`, { waitUntil: 'domcontentloaded' });
    const banner = page.locator('[data-deferred-banner]');
    const seen = await banner.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    check(seen, `${viewer.name}: плашка «ждёт решения» над разделом`);
    if (!seen) continue;
    // Язык приходит с настройками чуть позже первой отрисовки — ждём подпись, а не читаем сразу.
    const translated = await banner
      .filter({ hasText: BADGE[viewer.lang] })
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    check(
      translated,
      `${viewer.name}: подпись плашки на языке зрителя`,
      (await banner.textContent())?.slice(0, 120),
    );
    await banner.getByRole('button', { expanded: false }).first().click();
    check(
      await banner
        .getByText(REASON[viewer.lang])
        .first()
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        ),
      `${viewer.name}: причина на языке зрителя, не текст для агента`,
      (await banner.textContent())?.slice(0, 400),
    );
    if (viewer.lang === 'ru') {
      check(
        !((await banner.textContent()) ?? '').includes('permission rows'),
        `${viewer.name}: английского текста для агента в русской плашке нет`,
      );
    }
    const row = banner.getByText(id, { exact: false }).first();
    check(
      await row.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      ),
      `${viewer.name}: раскрытая плашка называет ${id}`,
    );
    await ui.shot(viewer, 'banner', banner);

    await page.goto(`${webUrl}/chat?id=${encodeURIComponent(parentChatId)}`, {
      waitUntil: 'domcontentloaded',
    });
    const hub = page.locator('[data-hub-deferred]');
    const inHub = await hub.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    check(inHub, `${viewer.name}: раздел D-n в хабе родителя`);
    if (inHub) {
      check(((await hub.textContent()) ?? '').includes(id), `${viewer.name}: в хабе запись ${id}`);
      await ui.shot(viewer, 'hub', hub);
    }
  }
}

/** Одиночный чат открыт до карточки: зрители смотрят, карточка первой. */
export async function openChatUi(ui, webUrl, chatId) {
  await Promise.all(
    ui.viewers.map((viewer) =>
      viewer.page.goto(`${webUrl}/chat?id=${encodeURIComponent(chatId)}`, {
        waitUntil: 'domcontentloaded',
      }),
    ),
  );
}

/** Срок вышел: живая карточка в каждом окне сменилась отложенной с номером. */
export async function checkChatUi(ui, id, check) {
  for (const viewer of ui.viewers) {
    const card = viewer.page.locator('[data-permission-deferred]');
    const seen = await card.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    check(seen, `${viewer.name}: карточка прав стала отложенной`);
    if (!seen) {
      await ui.shot(viewer, 'card-missing');
      continue;
    }
    const text = (await card.textContent()) ?? '';
    check(
      CARD[viewer.lang].test(text) && text.includes(id),
      `${viewer.name}: карточка называет ${id} на языке зрителя`,
      text.slice(0, 160),
    );
    await ui.shot(viewer, 'card-deferred', card);
  }
}

/** Живая карточка до срока — снимок окна целиком, для пары «до/после». */
export async function shotLiveCard(ui) {
  for (const viewer of ui.viewers) await ui.shot(viewer, 'card-live');
}
