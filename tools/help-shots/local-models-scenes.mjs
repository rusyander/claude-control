/**
 * Сценарии справки «Локальные модели».
 *
 *   localModels/first — раздел от первого входа до агентов на своей карте:
 *                       подбор под карту, загрузка с полосой, готовый сервер
 *                       с моделью в памяти, выбор набора. Подсказки под полем чата
 *                       больше нет (владелец 06.10) — она вверху раздела.
 *
 * Снимаются области (карточки — регионы с именем), а не окно целиком: на кадре
 * всей страницы строку каталога или полосу загрузки не прочитать.
 *
 * Раздел разложен по вкладкам (`?tab=hardware|models|agents`): каждый кадр
 * открывает свою вкладку адресом, иначе нужной карточки на странице просто нет.
 */
import { STATES, localModelsRoutes } from './local-models-stubs.mjs';
import { settings } from './chat-stubs.mjs';

const region = (ru, en) =>
  `[role="region"][aria-label="${ru}"], [role="region"][aria-label="${en}"]`;
const CATALOG = region('Модели для кода', 'Coding models');
const AGENTS = region('Агенты на локальной модели', 'Agents on the local model');

async function openTab(page, web, tab, selector = '[role="region"]') {
  await page.goto(`${web}/local-models?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForSelector(selector);
  await page.waitForTimeout(1200);
}

/** Новое состояние — перезагрузкой: адрес, а с ним и вкладка, остаются прежними. */
async function switchTo(page, holder, name, selector = '[role="region"]') {
  holder.state = STATES[name];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selector);
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
    await openTab(page, web, 'hardware');

    // ── 01. Первый вход: карта, сервер не установлен (вкладка «Железо и сервер») ──
    await scenario.shot(page, '01-machine');

    // ── 02. Каталог крупно: «Рекомендуем», что влезет и почему не агент ──────
    await openTab(page, web, 'models', CATALOG);
    await scenario.shot(page, '02-catalog', { clip: CATALOG, padding: 12 });

    // ── 03. Загрузка: полоса, скорость, сколько осталось ────────────────────
    await switchTo(page, holder, 'pulling', CATALOG);
    await scenario.shot(page, '03-pulling', { clip: CATALOG, padding: 12 });

    // ── 04. Готово: сервер запущен, где считать, «В памяти» (вкладка «Железо и сервер») ──
    holder.state = STATES.ready;
    await openTab(page, web, 'hardware');
    await scenario.shot(page, '04-ready');

    // ── 05. Агенты и набор: облако одной кнопкой, чей набор у агента ────────
    await openTab(page, web, 'agents', AGENTS);
    // Снимок области вне окна пуст — карточку держим в окне.
    await page.locator(AGENTS).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '05-agents', { clip: AGENTS, padding: 12 });
  } finally {
    await page.close();
  }
}
