/**
 * Сценарий раздела «Провайдеры»: `providers/switch`.
 *
 * Вход один и очень узкий: в системе стоит не только Claude Code, и человек
 * хочет, чтобы панель управляла другим CLI. Дальше всё, что он увидит, — это
 * ответы на три вопроса подряд: кого панель нашла, работает ли выбранный на
 * ЭТОЙ машине и сходятся ли форматы его конфигов с опубликованной схемой.
 *
 * Проверка провайдера запускается БЕЗ ассистента: один запрос к модели тратил
 * бы подписку владельца стенда, а без него проверка честно остаётся частичной —
 * именно это и видно в кадре.
 */
import { join } from 'node:path';
import { openSettingsTab, card, shotCard, STAND } from './access-providers-fixture.mjs';

/**
 * Выдуманный ключ: собирается из кусков, чтобы в файле не лежала строка вида ключа. Хвост
 * `FAKE` — панель показывает его в карточке («sk-…FAKE»), и кадр, ушедший мимо замазывания
 * (03.11.2026, dark-en, «sk-…a1d2»), не оставлял бы вопроса, чей это ключ. Замазывается он всё
 * равно: правило кадра не знает исключений.
 */
const FAKE_KEY = ['sk', 'demo', 'qa', '3f8a21d05c6b4e97FAKE'].join('-');

/**
 * Где лежит CLI — ответ системы, а не стенда: панель ищет его в PATH машины съёмки, и строка
 * «Запускается Codex (OpenAI) 0.155.1: <путь>» везла в справку настоящий каталог установки
 * (03.11.2026, `C:\…\nodejs\codex.cmd`). Ответ `/api/chat/cli` остаётся настоящим — найдена ли
 * копия, её версия, есть ли новее, — в стенд переезжает только каталог: имя файла сохраняется,
 * папка — `<стенд>\bin`. Запрос обновления (`/api/chat/cli/update`) не трогается.
 */
async function standCliPaths(page) {
  const bin = join(STAND, 'bin');
  const move = (path) => (typeof path === 'string' ? join(bin, path.split(/[\\/]/).pop()) : path);
  const moveInstall = (install) => (install ? { ...install, path: move(install.path) } : install);
  await page.route(/\/api\/chat\/cli(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const info = await response.json();
    await route.fulfill({
      response,
      json: {
        ...info,
        ...(info.path ? { path: move(info.path) } : {}),
        ...(Array.isArray(info.installs) ? { installs: info.installs.map(moveInstall) } : {}),
        ...(info.newer ? { newer: moveInstall(info.newer) } : {}),
      },
    });
  });
}

export async function shootSwitch(browser, web, scenario, { panel }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1500 } });
  await standCliPaths(page);

  try {
    await setProvider(panel, 'claude');

    // ── 01. Кого панель нашла ────────────────────────────────────────────────
    // Бейджи в списке — не обещание, а факт: «проверено» стоит у Claude, у
    // остальных «экспериментально», и рядом видно, сколько разделов готово.
    await openSettingsTab(page, web, 'providers', 3000);
    await shotCard(scenario, page, '01-selector', card('Провайдер конфигурации'));

    // ── 02. Переключение ─────────────────────────────────────────────────────
    // Кнопка берётся из СТРОКИ нужного CLI, а не первая в карточке: порядок
    // строк задаёт каталог провайдеров и меняется вместе с ним.
    await page
      .locator(row('Codex (OpenAI)'))
      .getByRole('button', { name: /^(Выбрать|Choose)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '02-chosen', card('Провайдер конфигурации'));

    // ── 03. Что проверка делает ──────────────────────────────────────────────
    // Кадр до запуска: здесь написано, что запись пойдёт по ВРЕМЕННОЙ копии,
    // и стоит тумблер «запускать ассистента» — единственный платный шаг.
    const checkCard = card2('Проверка провайдера', 'Provider check');
    await shotCard(scenario, page, '03-check', checkCard);

    // ── 04. Что она ответила ─────────────────────────────────────────────────
    await page
      .locator(checkCard)
      .getByRole('button', { name: /^(Проверить|Run check)$/ })
      .first()
      .click();
    await page.waitForTimeout(12000);
    await shotCard(scenario, page, '04-check-result', checkCard);

    // ── 05. Ключ провайдера ──────────────────────────────────────────────────
    // Значение уходит в зашифрованное хранилище и обратно не возвращается:
    // карточка показывает только маску, и в кадре она закрыта ещё раз.
    const keysCard = card('API-ключи провайдеров');
    const keyField = page.locator(keysCard).locator('input[type="password"]').first();
    if (await keyField.count()) {
      await keyField.fill(FAKE_KEY);
      await page.waitForTimeout(500);
      await page
        .locator(keysCard)
        .getByRole('button', { name: /^(Сохранить|Save)$/ })
        .first()
        .click();
      await page.waitForTimeout(2500);
    }
    await shotCard(scenario, page, '05-keys', keysCard);

    // ── 06. Сходятся ли форматы со схемами ───────────────────────────────────
    const formatCard = card('Сверка форматов со схемами');
    await page
      .locator(formatCard)
      .getByRole('button', { name: /^(Проверить сейчас|Check now)$/ })
      .first()
      .click();
    await page.waitForTimeout(15000);
    await shotCard(scenario, page, '06-format', formatCard);

    // ── 07. Что меняется во всей панели ──────────────────────────────────────
    // Кадр на всю страницу: смена провайдера переписывает левое меню — разделы,
    // которых у этого CLI нет, из него исчезают.
    await scenario.shot(page, '07-panel');

    // Возвращаем Claude: следующие сценарии снимаются на нём.
    await setProvider(panel, 'claude');
  } finally {
    await page.close();
  }
}

/**
 * Карточка, чей заголовок начинается с этих слов: имя провайдера в нём
 * меняется. Оба языковых варианта — русский и английский, по тому же ключу
 * `providerCheck.title`, что рендерит карточка.
 */
const card2 = (prefixRu, prefixEn) =>
  `xpath=//*[starts-with(normalize-space(text()),"${prefixRu}") or ` +
  `starts-with(normalize-space(text()),"${prefixEn}")]/ancestor::div[contains(@class,"padding-md")][1]`;

/** Строка одного CLI внутри карточки выбора: это вложенная карточка поменьше. */
const row = (name) =>
  `xpath=//*[normalize-space(text())="${name}"]/ancestor::div[contains(@class,"padding-sm")][1]`;

async function setProvider(panel, provider) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings provider: ${response.status}`);
}
