/**
 * Кейс chat-004: неподходящее вложение отклоняется с понятной причиной —
 * `.exe` отказом «тип не поддерживается» без вложения, файл больше лимита
 * отказом с его размером и лимитом; ни один отказ не молчаливый, поле ввода
 * остаётся рабочим, а сообщение с таким вложением не уходит в сеть.
 *
 * Файлы подаются в настоящий `<input type=file>` поля ввода — тот же
 * обработчик, что после выбора в системном диалоге. Отказ ищется в тостах
 * страницы, вложение — по чипу с кнопкой «Удалить: <имя>». Сеть — журнал
 * запросов страницы: POST в API чата после отказа быть не должно.
 *
 * Панель проверяет тип при ОТПРАВКЕ, а не при вложении (useChatSend.ts,
 * `planSend`): чип `.exe` появляется, отказ приходит по «Отправить». Строка
 * «вложение не добавлено» поэтому красная, пока кейс и продукт расходятся; сам
 * отказ при отправке проверяется отдельными строками.
 *
 * Модель не нужна: оба отказа случаются в браузере до любого запроса.
 *
 * Запуск: `node tools/qa/check-chat-attach-refusal.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const TEXT = 'проверка вложений';
const EXE = 'tool.exe';
const BIG = 'big.pdf';
const BIG_BYTES = 25 * 1024 * 1024;

await runOnStand({ label: 'chat-attach' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    const posts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/chat/.test(request.url()))
        posts.push(request.url());
    });
    await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
    // Окно «нужен доступ» (у стенда нет входа в CLI) прячет страницу от дерева
    // доступности — ждём разметку поля, затем закрываем окно его же кнопкой.
    // Окно приходит не сразу — после ответа о доступе, поэтому его ждут, а не
    // проверяют один раз.
    await page.locator('textarea[data-chat-input]').waitFor({ timeout: 90_000 });
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

    // Своей подписи у поля нет (имя — из placeholder, он меняется с режимом), поэтому
    // поле берётся по его метке в разметке.
    const field = page.locator('textarea[data-chat-input]');
    await field.fill(TEXT);
    const fileInput = page.locator('input[type="file"]').first();
    // Тост панели — свой (shared/ui/toast): ошибка идёт ролью alert, прочее — status.
    const toastBox = page.locator('[role="alert"], [role="status"]');
    const toasts = async () =>
      (await toastBox.allInnerTexts())
        .map((text) => text.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const chip = (name) => page.getByRole('button', { name: `Удалить: ${name}` });
    // Прошлый отказ не должен сойти за следующий: ждём, пока тост про .exe уйдёт.
    const dismissToasts = async () => {
      await toastBox
        .filter({ hasText: EXE })
        .first()
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => undefined);
    };

    // --- .exe
    await fileInput.setInputFiles({
      name: EXE,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ\x90\x00probe'),
    });
    await wait(1200);
    const onAttach = await toasts();
    console.log(`  .exe при вложении: тосты [${onAttach.join(' | ')}]`);
    check(
      '.exe: при вложении отказ с причиной «тип не поддерживается»',
      onAttach.some((text) => text.includes(EXE) && /не умеет передавать|Допустимые/.test(text)),
      onAttach.join(' | ') || 'отказа при вложении нет',
    );
    check(
      '.exe: вложение не добавлено',
      (await chip(EXE).count()) === 0,
      'чип tool.exe появился: тип проверяется только при отправке',
    );

    if ((await chip(EXE).count()) > 0) {
      const before = posts.length;
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      await wait(1500);
      const onSend = await toasts();
      console.log(`  .exe при отправке: тосты [${onSend.join(' | ')}]`);
      check(
        '.exe: при отправке — отказ, названы файл и допустимые расширения',
        onSend.some(
          (text) => text.includes(EXE) && /не умеет передавать/.test(text) && /\.pdf/.test(text),
        ),
        onSend.join(' | ') || 'отказа нет',
      );
      check(
        '.exe: сообщение не ушло в сеть',
        posts.length === before,
        posts.slice(before).join(', '),
      );
      check('.exe: набранный текст остался в поле', (await field.inputValue()) === TEXT);
      await chip(EXE).click();
      await wait(300);
    }
    await dismissToasts();

    // --- больше лимита
    await fileInput.setInputFiles({
      name: BIG,
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(BIG_BYTES, 0x20),
    });
    await wait(2000);
    const onBig = await toasts();
    console.log(`  большой файл: тосты [${onBig.join(' | ')}]`);
    const bigRefusal = onBig.find((text) => text.includes(BIG)) ?? '';
    check('больше лимита: отказ на экране, файл назван', bigRefusal.length > 0, onBig.join(' | '));
    check(
      'больше лимита: в отказе назван лимит',
      /20(\.0)? ?MB|20 МБ/.test(bigRefusal),
      bigRefusal,
    );
    check(
      'больше лимита: в отказе назван размер файла',
      /25(\.0)? ?MB|25 МБ/.test(bigRefusal),
      bigRefusal || 'отказа нет',
    );
    check('больше лимита: вложение не добавлено', (await chip(BIG).count()) === 0);

    // --- поле рабочее, запросов не было
    await field.press('End');
    await field.pressSequentially(' ещё');
    check(
      'поле ввода остаётся рабочим',
      (await field.inputValue()) === `${TEXT} ещё` && (await field.isEnabled()),
      await field.inputValue(),
    );
    check('ни одного POST в API чата за весь сценарий', posts.length === 0, posts.join(', '));
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
