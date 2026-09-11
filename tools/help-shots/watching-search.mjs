/**
 * Сценарий «Поиск»: помню слово, не помню раздел.
 *
 * Вход у раздела один, и делить его не на что: и тот, кто ищет правило, и тот,
 * кто ищет переменную, начинают с одной строки. Разными бывают не входы, а
 * ОТВЕТЫ, и кадры показывают четыре разных: подсказка до запроса, выдача из
 * двух разделов сразу, выдача по именам переменных и честное «ничего».
 *
 * Ищет настоящий сервер по настоящим файлам фикстуры — заглушек здесь нет
 * вовсе: вся ценность кадра в том, что найденное действительно лежит на диске.
 */
import { settings, location, open, frame } from './watching-stubs.mjs';

/** Ввести запрос и дождаться, пока отработает задержка ввода и ответ сервера. */
async function ask(page, text) {
  const field = page.locator('input[type="search"]').first();
  await field.fill('');
  await field.fill(text);
  await page.waitForTimeout(1400);
}

export async function shootFind(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    await location(page);
    await open(page, web, '/search');

    // ── 01. До запроса: раздел говорит, где будет искать ─────────────────────
    await frame(scenario, page, '01-prompt');

    // ── 02. Одно слово — два раздела: правило и право ────────────────────────
    await ask(page, 'migrations');
    await frame(scenario, page, '02-two-sections');

    // ── 03. Переменные: ищутся имена, значения не показываются вовсе ─────────
    await ask(page, 'TOKEN');
    await frame(scenario, page, '03-variables');

    // ── 04. Ничего не найдено — и это тоже ответ ─────────────────────────────
    await ask(page, 'выгрузка склада');
    await frame(scenario, page, '04-empty');
  } finally {
    await page.close();
  }
}
