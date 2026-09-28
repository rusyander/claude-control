/**
 * Кейс access-integrations-004: секретная переменная хранится, но наружу не
 * отдаётся — в списке маска «точки + 2 последних символа», полного значения
 * нет ни на экране, ни в ответе API списка переменных; удаление убирает её.
 *
 * Путь настоящий: форма «Добавить переменную» одноразового стенда →
 * `.mcp-secrets.env` временного каталога. Ответ API ловится в самой странице
 * (то, что видно в DevTools), и отдельно запрашивается напрямую. Оракул
 * «хранится» — файл на диске: маска без сохранённого значения ничего не стоит.
 *
 * Запуск: `node tools/qa/check-env-secret.mjs` (стенд поднимается сам).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const KEY = 'PROBE_TOKEN';
const VALUE = 'Zq7xK2mP9wLr';

/** Все файлы временного каталога, где встречается значение, — чтобы найти, куда оно легло. */
const filesWith = (dir, needle) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((path) => {
      try {
        return readFileSync(path, 'utf8').includes(needle);
      } catch {
        return false;
      }
    });

await runOnStand({ label: 'env-secret' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1200 });
    const listBodies = [];
    page.on('response', async (res) => {
      if (/\/api\/env(\?|$)/.test(res.url()) && res.request().method() === 'GET') {
        listBodies.push(await res.text().catch(() => ''));
      }
    });
    await page.goto(`${stand.webUrl}/env`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Добавить переменную' }).first().click();
    const form = page.getByRole('dialog').filter({ has: page.getByLabel('Имя переменной') });
    await form.waitFor({ timeout: 30_000 });
    await form.getByLabel('Имя переменной').fill(KEY);
    await form.getByLabel('Значение', { exact: true }).fill(VALUE);
    await form.getByRole('button', { name: 'Сохранить' }).click();
    await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);

    const stored = filesWith(stand.cfg, `${KEY}=${VALUE}`).concat(
      stand.cfg.startsWith(stand.home) ? [] : filesWith(stand.home, `${KEY}=${VALUE}`),
    );
    console.log(`  значение лежит в: ${stored.join(', ') || 'нигде'}`);
    check(
      'значение сохранено в файле секретов',
      stored.some((path) => path.endsWith('.mcp-secrets.env')),
      stored.join(', '),
    );

    // F5 — список заново с сервера.
    listBodies.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-agent-anchor]').filter({ hasText: KEY });
    await row.first().waitFor({ timeout: 30_000 });
    await wait(500);
    const rowText = await row.first().innerText();
    const shownMask = (rowText.match(/[^\s]*•[^\s]*/) ?? [''])[0];
    console.log(`  маска на экране: «${shownMask}»`);
    check('экран: полного значения нет', !(await page.content()).includes(VALUE));
    check(
      'экран: маска — точки и 2 последних символа',
      new RegExp(`^•+${VALUE.slice(-2)}$`).test(shownMask),
      `показано «${shownMask}», открыто символов значения: ${shownMask.replace(/•/g, '').length} из ${VALUE.length}`,
    );
    check('API (как в DevTools): ответ списка перехвачен', listBodies.length > 0);
    check(
      'API (как в DevTools): полного значения в ответе нет',
      listBodies.every((body) => !body.includes(VALUE)),
    );
    const direct = await stand.api('/env');
    check(
      'API напрямую: полного значения нет',
      !direct.text.includes(VALUE),
      direct.text.slice(0, 300),
    );

    // Удаление.
    await row
      .first()
      .getByRole('button', { name: `Удалить: ${KEY}` })
      .click();
    const confirm = page.getByRole('dialog').last();
    await confirm.waitFor();
    const typed = confirm.getByRole('textbox');
    if ((await typed.count()) > 0) await typed.first().fill(KEY);
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);
    check('удаление: в списке переменной нет', (await row.count()) === 0);
    check(
      'удаление: в файле секретов значения нет',
      stored.every((path) => !existsSync(path) || !readFileSync(path, 'utf8').includes(VALUE)),
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
