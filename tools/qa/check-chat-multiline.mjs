/**
 * Кейс chat-002: Shift+Enter переносит строку, Enter отправляет всё поле
 * целиком — одно сообщение из двух строк.
 *
 * Клавиши нажимаются в настоящем поле ввода чата. «Ничего не отправлено» и
 * «отправлено одно сообщение» — журнал запросов страницы: POST отправки в API
 * чата и его тело (промпт с переводом строки). Реплика в ленте — пузырь
 * человека, который страница показывает сразу, до ответа модели.
 *
 * Модель не нужна и не вызывается: у одноразового стенда нет `claude` в PATH,
 * поэтому сервер откажет запуску — но запрос уже ушёл, и его тело и есть то,
 * что CLI получил бы. Отказ сервера кейс не проверяет.
 *
 * Запуск: `node tools/qa/check-chat-multiline.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const FIRST = 'строка 1';
const SECOND = 'строка 2';

await runOnStand({ label: 'chat-multiline' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    const sends = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/chat/.test(request.url()))
        sends.push({ url: request.url(), body: request.postData() ?? '' });
    });
    await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
    // Своей подписи у поля нет (имя — из placeholder), берём по метке в разметке.
    const field = page.locator('textarea[data-chat-input]');
    await field.waitFor({ timeout: 90_000 });
    // Окно «нужен доступ» (у стенда нет входа в CLI) приходит после ответа о
    // доступе — его ждут и закрывают его же кнопкой.
    const blocking = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
    await blocking
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    if ((await blocking.count()) > 0) {
      await blocking.first().getByRole('button', { name: 'Закрыть' }).first().click();
      await blocking
        .first()
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() => undefined);
    }

    await field.click();
    await field.pressSequentially(FIRST);
    await field.press('Shift+Enter');
    await field.pressSequentially(SECOND);
    await wait(800);
    const typed = await field.inputValue();
    check('Shift+Enter: в поле две строки', typed === `${FIRST}\n${SECOND}`, JSON.stringify(typed));
    check('Shift+Enter: ничего не отправлено', sends.length === 0, JSON.stringify(sends));

    await field.press('Enter');
    await wait(2500);
    console.log(
      `  запросы после Enter: ${sends.map((s) => `${s.url} ${s.body.slice(0, 160)}`).join(' | ')}`,
    );
    const prompts = sends
      .map((send) => {
        try {
          return JSON.parse(send.body).prompt;
        } catch {
          return undefined;
        }
      })
      .filter((prompt) => typeof prompt === 'string');
    check('Enter: ушло ровно одно сообщение', prompts.length === 1, JSON.stringify(sends));
    check(
      'Enter: сообщение — обе строки с переводом строки между ними',
      prompts[0]?.includes(`${FIRST}\n${SECOND}`) === true,
      JSON.stringify(prompts[0]),
    );
    // Реплика человека в ленте: обе строки в одном пузыре, перевод строки сохранён.
    const bubble = await page.locator('main').evaluate(
      (main, [first, second]) =>
        [...main.querySelectorAll('*')]
          .filter((node) => node.children.length === 0 || node.tagName === 'P')
          .map((node) => node.innerText ?? '')
          .find((text) => text.includes(first) && text.includes(second)) ?? '',
      [FIRST, SECOND],
    );
    check(
      'лента: одно сообщение, в тексте перевод строки',
      bubble.includes(`${FIRST}\n${SECOND}`),
      JSON.stringify(bubble) || 'реплики в ленте нет',
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
