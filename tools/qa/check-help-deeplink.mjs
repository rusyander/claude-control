/**
 * Кейс help-002: ссылка `/help?topic=tests` открывает документ «Тесты» сразу,
 * а неизвестная тема (`?topic=nope`) — не белый экран, а понятное «такого
 * раздела нет» с дорогой к оглавлению.
 *
 * Стенд одноразовый (справка только читается, но так прогон не зависит от
 * того, поднят ли `pnpm dev`). Открывается прямо адрес — как по ссылке из чата
 * или из письма, без перехода внутри приложения.
 *
 * Запуск: `node tools/qa/check-help-deeplink.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

await runOnStand({ label: 'help-deeplink' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    await page.goto(`${stand.webUrl}/help?topic=tests`, { waitUntil: 'domcontentloaded' });
    const heading = page.getByRole('heading', { level: 1 });
    await heading.first().waitFor({ timeout: 30_000 });
    await wait(500);
    const title = (await heading.first().innerText()).trim();
    check('?topic=tests: заголовок документа «Тесты»', title === 'Тесты', title);
    check(
      '?topic=tests: есть кнопка «Перейти в раздел» (это документ, а не оглавление)',
      (await page.getByRole('button', { name: 'Перейти в раздел' }).count()) > 0,
    );
    check('?topic=tests: адрес не переписан', page.url().includes('topic=tests'), page.url());

    await page.goto(`${stand.webUrl}/help?topic=nope`, { waitUntil: 'domcontentloaded' });
    await page
      .getByText('Такого раздела справки нет')
      .waitFor({ timeout: 30_000 })
      .catch(() => undefined);
    const main = (
      await page
        .locator('main')
        .innerText()
        .catch(() => '')
    ).trim();
    check('?topic=nope: страница не пустая', main.length > 40, JSON.stringify(main.slice(0, 200)));
    check(
      '?topic=nope: сказано «Такого раздела справки нет»',
      main.includes('Такого раздела справки нет'),
      main.slice(0, 300),
    );
    const back = page
      .getByRole('link')
      .filter({ has: page.getByRole('button') })
      .filter({ hasText: 'Все разделы' });
    check('?topic=nope: есть путь к оглавлению', (await back.count()) > 0);
    if ((await back.count()) > 0) {
      await back.first().click();
      await wait(800);
      check(
        'переход ведёт в оглавление /help без темы',
        !page.url().includes('topic='),
        page.url(),
      );
      check(
        'оглавление перечисляет темы (есть ссылка на «Тесты»)',
        (await page.getByRole('link', { name: /Тесты/ }).count()) > 0,
      );
    }
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
