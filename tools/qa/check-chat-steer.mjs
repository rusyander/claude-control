/**
 * Сообщение агенту посреди хода — на одноразовой панели (F-4). До этого путь
 * «Передаётся…» был доказан только тестами стора и отрисовки, на стенде — нет.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-chat-steer.mjs`) с
 * живой сессией: он держит ход и, как настоящий CLI, отдаёт сообщение, пришедшее
 * посреди хода, модели в ТОМ ЖЕ ходе. Всё между ним и человеком настоящее: поле
 * ввода, `agentRuns.steer`, POST /api/chat/send со `steer: true`, реестр
 * прогонов, запись в stdin живого процесса, событие `steer` в потоке, лента.
 *
 * Свидетельства — что ДОШЛО до процесса (`turns.jsonl`: сообщение пришло во
 * время хода, итог один) и что видно человеку:
 *  1. посреди хода Enter → поле пустеет, пузырь «Передаётся…» стоит СРАЗУ, пока
 *     ответ сервера задержан (вариация по времени), убрать его нельзя;
 *  2. ответ пришёл → подпись «Передано агенту…», процесс получил сообщение
 *     посреди хода, итог «УЧЁЛ: …» в том же ходе, второго хода нет;
 *  3. после хода и после F5 — сообщение в ленте один раз, призраков нет;
 *  4. отрицательный: сервер отказал (409) → «Передаётся…» снят, сообщение в
 *     очереди «уйдёт следующим» с крестиком, процесс посреди хода его НЕ получил,
 *     с концом хода оно ушло само обычным ходом.
 *
 * Запуск: node tools/qa/check-chat-steer.mjs   (браузеры: pnpm qa:setup)
 */
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_STEER_CLI } from './fake-cli-chat-steer.mjs';
import { readTurns } from './fake-cli-append.mjs';
import { dismissAccess } from './chat-walk.mjs';

await runOnStand(
  { label: 'chat-steer', fakeCli: { claude: FAKE_STEER_CLI } },
  async (stand, check) => {
    const browser = await chromium.launch();
    const turns = () => readTurns(stand.read, stand.bin);
    const waitTurn = async (pred, seconds = 30) => {
      for (let i = 0; i < seconds * 10; i += 1) {
        const found = turns().filter(pred);
        if (found.length) return found.at(-1);
        await wait(100);
      }
      return undefined;
    };
    const page = await stand.newPage(browser, { height: 1000 });
    const input = page.locator('textarea[data-chat-input]');
    const main = page.locator('main');
    const occurrences = async (text) =>
      main.evaluate(
        (root, needle) =>
          [...root.querySelectorAll('*')].filter(
            (node) =>
              node.children.length === 0 &&
              (node.textContent ?? '').trim() === needle &&
              !node.closest('[data-chat-input]'),
          ).length,
        text,
      );

    // Ответ сервера на «на ходу» держим, пока проверка не посмотрит на пузырь.
    let release;
    let refuse = false;
    await page.route('**/api/chat/send', async (route) => {
      const body = route.request().postDataJSON?.() ?? {};
      if (!body.steer) return route.continue();
      if (refuse) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'busy' }),
        });
      }
      await new Promise((done) => (release = done));
      return route.continue();
    });

    try {
      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 90_000 });
      await dismissAccess(page);
      await page.getByRole('button', { name: 'Новый чат' }).first().click();
      await input.waitFor({ timeout: 30_000 });
      await wait(500);

      // ------------------------------------------------------- 1–2. на ходу
      console.log('1–2. сообщение посреди хода');
      await input.fill('ДОЛГО: посчитай до тридцати');
      await input.press('Enter');
      const started = await waitTurn((t) => t.scenario === 'long-start');
      check('ход начался у процесса', Boolean(started));
      await wait(1200);
      const steerText = 'ПОПРАВКА: считай синим';
      await input.fill(steerText);
      await input.press('Enter');
      await wait(300);
      check('поле пустеет сразу', (await input.inputValue()) === '');
      const sending = page.locator('[data-steer-sending]');
      check(
        'пузырь «Передаётся…» стоит сразу, пока сервер не ответил',
        (await sending.count()) === 1 && /Передаётся/.test(await sending.innerText()),
      );
      check(
        '…и убрать его нельзя (крестика нет)',
        (await sending.getByRole('button', { name: 'Убрать' }).count()) === 0,
      );
      check('процесс сообщения ещё не получил', !turns().some((t) => t.scenario === 'steer-in'));
      if (process.env.SHOTS) {
        await page.screenshot({ path: join(process.env.SHOTS, 'chat-steer-sending.png') });
      }
      release?.();
      const steered = await waitTurn(
        (t) => t.scenario === 'steer-in' && t.prompt === steerText,
        10,
      );
      check('процесс получил сообщение посреди хода', Boolean(steered));
      const end = await waitTurn((t) => t.scenario === 'long-end', 30);
      check(
        'учтено в том же ходе: итог «УЧЁЛ», один result',
        end?.steers?.join() === steerText && end?.results === 1,
        JSON.stringify(end),
      );
      await page
        .getByText(`УЧЁЛ: ${steerText}`)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      check(
        'ответ с «УЧЁЛ» виден в ленте',
        (await page.getByText(`УЧЁЛ: ${steerText}`).count()) > 0,
      );
      await wait(1500);
      check(
        'второго хода нет',
        turns().filter((t) => t.scenario === 'plain' || t.scenario === 'long-start').length === 1,
      );
      check('призраков очереди нет', (await page.locator('[data-queued-message]').count()) === 0);
      check('сообщение в ленте ровно один раз', (await occurrences(steerText)) === 1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 30_000 });
      await page
        .getByText(steerText)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      check('после F5 — тоже один раз', (await occurrences(steerText)) === 1);

      // ----------------------------------------------- 4. отказ сервера → очередь
      console.log('4. сервер отказал — очередь');
      refuse = true;
      await input.fill('ДОЛГО: ещё раз');
      await input.press('Enter');
      const second = await waitTurn(
        (t) => t.scenario === 'long-start' && t.prompt === 'ДОЛГО: ещё раз',
      );
      check('второй долгий ход начался', Boolean(second));
      await wait(1200);
      const queuedText = 'ПОТОМ: это после хода';
      await input.fill(queuedText);
      await input.press('Enter');
      await wait(800);
      const queued = page.locator('[data-queued-message]');
      check('«Передаётся…» снят', (await page.locator('[data-steer-sending]').count()) === 0);
      check(
        'сообщение в очереди: «уйдёт следующим» и крестик',
        (await queued.count()) === 1 &&
          /следующ/i.test(await queued.innerText()) &&
          (await queued.getByRole('button').count()) >= 1,
      );
      const plain = await waitTurn((t) => t.scenario === 'plain' && t.prompt === queuedText, 30);
      const secondEnd = turns().find(
        (t) => t.scenario === 'long-end' && t.prompt === 'ДОЛГО: ещё раз',
      );
      check(
        'процесс посреди хода его НЕ получил',
        Boolean(secondEnd) &&
          secondEnd.steers.length === 0 &&
          !turns().some((t) => t.scenario === 'steer-in' && t.prompt === queuedText),
        JSON.stringify(secondEnd),
      );
      check('с концом хода ушло само обычным ходом', Boolean(plain));
      await page
        .getByText(`Принято: ${queuedText}`)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      check('ответ на него в ленте', (await page.getByText(`Принято: ${queuedText}`).count()) > 0);
      await wait(1000);
      check('очередь пуста', (await queued.count()) === 0);
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
