/**
 * Сценарии справки «Локальные модели».
 *
 *   localModels/first — раздел от первого входа до агентов на своей карте:
 *                       подбор под карту, загрузка с полосой, готовая модель
 *                       с замером, выбор набора. Подсказки под полем чата
 *                       больше нет (владелец 06.10) — она вверху раздела.
 *
 * Снимаются области (карточки — регионы с именем), а не окно целиком: на кадре
 * всей страницы строку каталога или полосу загрузки не прочитать.
 */
import { STATES, localModelsRoutes } from './local-models-stubs.mjs';
import { settings } from './chat-stubs.mjs';

const region = (ru, en) =>
  `[role="region"][aria-label="${ru}"], [role="region"][aria-label="${en}"]`;
const CATALOG = region('Модели для кода', 'Coding models');
const AGENTS = region('Агенты на локальной модели', 'Agents on the local model');

async function openPage(page, web) {
  await page.goto(`${web}/local-models`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForSelector('[role="region"]');
  await page.waitForTimeout(1200);
}

async function switchTo(page, holder, name) {
  holder.state = STATES[name];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role="region"]');
  await page.waitForTimeout(1200);
}

export async function shootFirst(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  // Ошибка рендера иначе видна только как таймаут ожидания карточки.
  page.on('pageerror', (error) => console.log(`  ошибка страницы: ${error.message}`));
  const holder = { state: STATES.empty };
  try {
    await settings(page);
    await localModelsRoutes(page, holder);
    await openPage(page, web);

    // ── 01. Первый вход: карта, сервер не установлен, каталог под эту карту ──
    await scenario.shot(page, '01-machine');

    // ── 02. Каталог крупно: «Рекомендуем», что влезет и почему не агент ──────
    await scenario.shot(page, '02-catalog', { clip: CATALOG, padding: 12 });

    // ── 03. Загрузка: полоса, скорость, сколько осталось ────────────────────
    await switchTo(page, holder, 'pulling');
    await scenario.shot(page, '03-pulling', { clip: CATALOG, padding: 12 });

    // ── 04. Готово: в памяти, замер, «Работает у агентов» ───────────────────
    await switchTo(page, holder, 'ready');
    await scenario.shot(page, '04-ready');

    // ── 05. Агенты и набор: облако одной кнопкой, чей набор у агента ────────
    // Карточка агентов ниже окна: снимок области вне окна пуст.
    await page.locator(AGENTS).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '05-agents', { clip: AGENTS, padding: 12 });
  } finally {
    await page.close();
  }
}
