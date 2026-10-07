/**
 * Основы чата на одноразовой панели (Ф22): кейсы chat-001, chat-003, chat-005,
 * chat-007, chat-009, ни разу не гонявшиеся.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-chat-basics.mjs`) на
 * PATH одноразовой панели; всё между ним и человеком настоящее: поле ввода,
 * маршрут отправки, процесс CLI с его argv, сохранение вложений в папку чата,
 * мост прав `perm-guard` из `--mcp-config`, правила «Разрешать без вопроса»,
 * разбор известной ошибки CLI и лента. Свидетельства — что ДОШЛО до процесса
 * (`turns.jsonl`: argv, рабочая папка, текст хода, решение моста) и что видно
 * человеку.
 *
 * - chat-001: поле пустеет сразу, сообщение встаёт в ленту, ответ течёт
 *   кусками (промежуточное состояние поймано), после F5 разговор в списке;
 * - chat-005: Sonnet и «Низкая» в шапке доходят до процесса `--model`/`--effort`;
 * - chat-003: PNG и PDF — две карточки над полем, оба вложения в сообщении,
 *   процесс прочитал их байты (размер картинки и число страниц);
 * - chat-007: «Удаление файлов» выключено — карточка прав с командой, отказ
 *   оставляет файл; включено — карточки нет, файл удалён; после F5 включено;
 * - chat-009: устаревший CLI — карточка ошибки словами интерфейса, сырой текст
 *   рядом, а не вместо.
 *
 * Что НЕ проверяется: качество ответа настоящей модели (что она увидела на
 * картинке) — это её работа, не панели.
 *
 * Запуск: node tools/qa/check-chat-basics.mjs   (браузеры: pnpm qa:setup)
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';
import { readTurns } from './fake-cli-append.mjs';
import { dismissAccess } from './chat-walk.mjs';

/** CRC32 для чанков PNG — без зависимостей. */
function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Настоящий PNG 3×2 (RGB): заголовок, данные, конец. */
function tinyPng() {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.from([
    0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0, 0, 0, 0, 0, 0,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PDF из двух страниц — ровно столько, сколько нужно, чтобы их сосчитать. */
const TWO_PAGE_PDF = [
  '%PDF-1.4',
  '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
  '2 0 obj <</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>> endobj',
  '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj',
  '4 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj',
  'trailer <</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

await runOnStand(
  { label: 'chat-basics', fakeCli: { claude: FAKE_BASICS_CLI } },
  async (stand, check) => {
    const browser = await chromium.launch();
    const turns = () => readTurns(stand.read, stand.bin);
    const turnOf = async (scenario, count, seconds = 30) => {
      for (let i = 0; i < seconds * 4; i += 1) {
        const found = turns().filter((turn) => turn.scenario === scenario);
        if (found.length >= count) return found[count - 1];
        await wait(250);
      }
      return undefined;
    };
    const page = await stand.newPage(browser, { height: 1000 });
    const input = page.locator('textarea[data-chat-input]');
    const main = page.locator('main');
    const lines = async () =>
      (await main.innerText().catch(() => '')).split('\n').map((line) => line.trim());

    const newChat = async () => {
      await page.getByRole('button', { name: 'Новый чат' }).first().click();
      await input.waitFor({ timeout: 30_000 });
      await wait(500);
    };

    try {
      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 90_000 });
      await dismissAccess(page);

      // ---------------------------------------------------------------- chat-001
      console.log('chat-001: отправка, поток, F5');
      await newChat();
      check(
        'новый чат: курсор в поле «Сообщение»',
        await page.evaluate(() => document.activeElement?.hasAttribute('data-chat-input') === true),
      );
      const ping = 'ПИНГ: Ответь одним словом: пинг';
      await input.fill(ping);
      await input.press('Enter');
      await wait(250);
      check('поле пустеет в тот же момент', (await input.inputValue()) === '');
      let sawUser = false;
      let sawPartial = false;
      let sawFinal = false;
      for (let i = 0; i < 80 && !sawFinal; i += 1) {
        const now = await lines();
        sawUser ||= now.includes(ping);
        sawPartial ||= now.includes('П') || now.includes('Пон');
        sawFinal = now.includes('Понг');
        await wait(100);
      }
      check('сообщение встало в ленту', sawUser);
      check('ответ пришёл по частям (поймано промежуточное «П…»)', sawPartial);
      check('в конце — одно слово «Понг»', sawFinal);
      await wait(1500);
      const pingUrl = new URL(page.url());
      check('у разговора есть адрес', pingUrl.searchParams.has('id'), page.url());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 30_000 });
      await dismissAccess(page);
      await wait(2500);
      check('после F5 разговор на месте', (await lines()).includes('Понг'));
      const listed = await page.evaluate(() =>
        [...document.querySelectorAll('a, button, [role="option"], [role="listitem"], li')].some(
          (node) => /ПИНГ/.test(node.textContent ?? '') && !node.closest('[data-chat-input]'),
        ),
      );
      check('в списке слева — разговор с названием', listed);

      // ---------------------------------------------------------------- chat-005
      console.log('chat-005: модель и глубина следующего хода');
      await newChat();
      const modelSelect = page.getByRole('combobox', { name: 'Модель' });
      const sonnet = await modelSelect
        .locator('option')
        .evaluateAll((options) => options.find((o) => /sonnet/i.test(o.textContent ?? ''))?.value);
      check('в выборе модели есть Sonnet', Boolean(sonnet));
      if (sonnet) await modelSelect.selectOption(sonnet);
      await page
        .getByRole('combobox', { name: 'Глубина продумывания' })
        .selectOption({ label: 'Низкая' });
      await wait(400);
      check(
        'на выборе модели написано Sonnet',
        /sonnet/i.test(
          await modelSelect.evaluate((node) => node.selectedOptions[0]?.textContent ?? ''),
        ),
      );
      check(
        'переключатель глубины показывает «Низкая»',
        (await page
          .getByRole('combobox', { name: 'Глубина продумывания' })
          .evaluate((node) => node.selectedOptions[0]?.textContent ?? '')) === 'Низкая',
      );
      await input.fill('МОДЕЛЬ: какая ты модель? Ответь коротко');
      await input.press('Enter');
      const modelTurn = await turnOf('model', 1);
      check(
        'ход выполнен Sonnet: --model дошёл до процесса',
        /sonnet/i.test(modelTurn?.model ?? ''),
        `argv model=${modelTurn?.model}`,
      );
      check(
        'глубина «Низкая» дошла: --effort low',
        modelTurn?.effort === 'low',
        `effort=${modelTurn?.effort}`,
      );
      await wait(1500);
      check(
        'ответ пришёл',
        (await lines()).some((line) => line.startsWith('Модель ') && /sonnet/i.test(line)),
      );

      // ---------------------------------------------------------------- chat-003
      console.log('chat-003: картинка и PDF');
      await newChat();
      const png = join(stand.root, 'qa-picture.png');
      const pdf = join(stand.root, 'qa-two-pages.pdf');
      writeFileSync(png, tinyPng());
      writeFileSync(pdf, TWO_PAGE_PDF, 'latin1');
      const attachInput = page.locator('input[data-chat-attach-input]');
      await attachInput.setInputFiles(png);
      await wait(500);
      const chip = (name) =>
        page
          .locator('form, [class*="composer"], div')
          .filter({ hasText: name })
          .getByRole('button');
      check(
        'над полем — карточка PNG с кнопкой удаления',
        (await chip('qa-picture.png').count()) > 0,
      );
      await attachInput.setInputFiles(pdf);
      await wait(500);
      const both = await page.evaluate(() => {
        const text = document.querySelector('textarea[data-chat-input]')?.closest('div')
          ?.parentElement?.parentElement?.textContent;
        return { text: text ?? '' };
      });
      check(
        'две карточки над полем',
        (await page.getByText('qa-picture.png').count()) > 0 &&
          (await page.getByText('qa-two-pages.pdf').count()) > 0,
        both.text.slice(0, 200),
      );
      await input.fill('ВЛОЖЕНИЯ: что на картинке и сколько страниц в PDF?');
      await input.press('Enter');
      const attachTurn = await turnOf('attach', 1);
      check(
        'процесс получил путь к PNG',
        Boolean(attachTurn?.png),
        JSON.stringify(attachTurn?.files),
      );
      check(
        'процесс получил путь к PDF',
        Boolean(attachTurn?.pdf),
        JSON.stringify(attachTurn?.files),
      );
      await wait(1500);
      const attachments = page.getByRole('list', { name: 'Приложенные файлы' }).last();
      const listedFiles = (await attachments.innerText().catch(() => '')).toLowerCase();
      check(
        'в сообщении видны оба вложения',
        listedFiles.includes('qa-picture') && listedFiles.includes('qa-two-pages'),
        listedFiles,
      );
      check(
        'ответ называет размер картинки и число страниц PDF (байты дошли)',
        (await lines()).includes('Картинка PNG 3×2, в PDF страниц: 2'),
        attachTurn?.text,
      );

      // ---------------------------------------------------------------- chat-007
      console.log('chat-007: «Удаление файлов» спрашивает или нет');
      await newChat();
      await input.fill('УДАЛИ: удали tmp-delete-me.txt командой rm');
      await input.press('Enter');
      const deny = page.getByRole('button', { name: 'Запретить' }).last();
      const asked = await deny
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check('выключенное правило: панель спрашивает права', asked);
      check(
        'в карточке — команда',
        asked && (await page.getByText('rm tmp-delete-me.txt').count()) > 0,
      );
      if (asked) await deny.click();
      const denied = await turnOf('delete', 1);
      check('отказ дошёл до процесса', denied?.decision === 'deny', `decision=${denied?.decision}`);
      check('файл на месте', Boolean(denied?.target && existsSync(denied.target)));
      await wait(1500);
      check(
        'агент сообщает об отказе',
        (await lines()).includes('Мне отказали в удалении — файл на месте.'),
      );

      const rule = async () => {
        await page.getByRole('button', { name: 'Настройки чата' }).first().click();
        const toggle = page.getByRole('switch', { name: /^Удаление файлов/ }).first();
        await toggle.waitFor({ timeout: 10_000 });
        return toggle;
      };
      const toggleOn = await rule();
      await toggleOn.click();
      await wait(800);
      check(
        'правило «Удаление файлов» включено',
        (await toggleOn.getAttribute('aria-checked')) === 'true',
      );
      await page.keyboard.press('Escape');
      await wait(400);
      await input.fill('УДАЛИ: ещё раз удали tmp-delete-me.txt');
      await input.press('Enter');
      const allowed = await turnOf('delete', 2);
      check(
        'включённое правило: карточки нет, разрешено само',
        allowed?.decision === 'allow',
        `decision=${allowed?.decision}`,
      );
      check('файл удалён', Boolean(allowed?.target) && !existsSync(allowed.target));
      check(
        'карточки прав нет',
        (await page.getByRole('button', { name: 'Запретить' }).count()) === 0,
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 30_000 });
      await dismissAccess(page);
      await wait(1500);
      const afterReload = await rule();
      check(
        'после F5 правило по-прежнему включено',
        (await afterReload.getAttribute('aria-checked')) === 'true',
      );
      await afterReload.click();
      await wait(800);
      check('выключено обратно', (await afterReload.getAttribute('aria-checked')) === 'false');
      await page.keyboard.press('Escape');

      // ---------------------------------------------------------------- chat-009
      console.log('chat-009: известная ошибка CLI словами');
      await newChat();
      await input.fill('СЛОМАЙСЯ: проверка ошибки');
      await input.press('Enter');
      const card = page.locator('[data-chat-error]').last();
      const shown = await card
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check('в ленте карточка ошибки', shown);
      const explained = shown
        ? await card
            .locator('[data-chat-error-explained]')
            .innerText()
            .catch(() => '')
        : '';
      check(
        'объяснение по-русски: что случилось и что сделать',
        /[а-яё]/i.test(explained) && explained.includes('2.1.999'),
        explained,
      );
      const whole = shown ? await card.innerText() : '';
      check(
        'сырой вывод CLI рядом, а не вместо объяснения',
        whole.includes('does not support this model') &&
          whole.indexOf(explained) < whole.indexOf('does not support'),
      );
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      if (process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'chat-basics-end.png') });
      await browser.close();
    }
  },
);
