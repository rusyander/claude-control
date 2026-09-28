/**
 * Картинки в КАЖДОМ поле агента (12b): кнопка, вставка Ctrl+V и перетаскивание —
 * в агенте панели, помощнике формы, помощнике структуры, ассистенте шага группы,
 * чате чужого CLI и чате Claude, в светлой и тёмной теме. Свидетельство — то,
 * что ДОШЛО: фальшивый CLI на PATH одноразовой панели пишет в `calls.jsonl`
 * картинки из потокового ввода (`--input-format stream-json`), и они сверяются
 * байт в байт с приложенными. Чат чужого CLI — файл, который панель положила
 * (`/api/media/agent-files`), и его путь во вложениях отправки; чат Claude —
 * тело запроса отправки (файл в папку чата кладёт прежний путь).
 *
 * Отказы: не картинка, больше 20 МБ (с настоящим размером), больше восьми.
 * Ужатие: снимок 3200×1800 доходит длинной стороной не больше 1568.
 * Ширина окна агента: перетаскивание, клавиатура, память через перезагрузку,
 * границы, узкий экран без ручки.
 *
 * Стенд одноразовый (`throwaway-stand.mjs`): свой дом, свой PATH, ничего
 * человека не трогает. Запуск: `node tools/qa/check-agent-images.mjs
 * [--only panel,form,structure,step,foreign,chat,resize,refusals]
 * [--shots <dir>]`.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_CLI_SOURCE } from './fake-cli-images.mjs';

const argOf = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const only = argOf('--only') ? new Set(argOf('--only').split(',')) : undefined;
const wants = (name) => !only || only.has(name);
const SHOTS = argOf('--shots');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ── Картинки ────────────────────────────────────────────────────────────────

/** PNG заданного размера одним цветом — собран руками, без зависимостей. */
function makePng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Размер картинки по байтам (PNG или JPEG). */
function dimensionsOf(base64) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes[0] === 0x89) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  for (let at = 2; at < bytes.length - 9;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

const PNG_A = makePng(40, 30, [220, 40, 40]);
const PNG_B = makePng(30, 40, [40, 120, 220]);
const PNG_C = makePng(24, 24, [40, 180, 90]);
const PNG_BIG = makePng(3200, 1800, [250, 200, 20]);
const PATHS = [
  { way: 'button', png: PNG_A },
  { way: 'paste', png: PNG_B },
  { way: 'drop', png: PNG_C },
];

// ── Сценарий ────────────────────────────────────────────────────────────────

await runOnStand(
  {
    label: 'agent-images',
    settings: { theme: 'system' },
    fakeCli: { claude: FAKE_CLI_SOURCE, codex: FAKE_CLI_SOURCE },
    seed: ({ cfg }) => {
      mkdirSync(join(cfg, 'skills', 'qa-skill'), { recursive: true });
      writeFileSync(
        join(cfg, 'skills', 'qa-skill', 'SKILL.md'),
        '---\nname: qa-skill\ndescription: QA skill for images.\n---\n\nBody.\n',
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const calls = () => {
      const file = join(stand.bin, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    /** Новый вызов CLI после отметки `since` (число вызовов до отправки). */
    const nextCall = async (since, cli = 'claude', timeout = 45_000) => {
      for (let t = 0; t < timeout; t += 250) {
        const found = calls()
          .slice(since)
          .filter((call) => call.cli === cli);
        if (found.length > 0) return found.at(-1);
        await wait(250);
      }
      return undefined;
    };
    const sameImage = (call, png) =>
      call?.images?.length === 1 && call.images[0].data === png.toString('base64');

    const group = await stand.api('/groups', { method: 'POST', body: { name: 'QA Images' } });
    check('группа для ассистента шага заведена', group.status === 200, String(group.status));

    const browser = await chromium.launch();
    try {
      for (const scheme of ['light', 'dark']) {
        console.log(`\n── Тема: ${scheme}`);
        const context = await browser.newContext({
          viewport: { width: 1400, height: 950 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const shot = async (name) => {
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}_${scheme}.png`) });
        };

        /** Приложить картинку одним из трёх путей в поле `scope`/`field`. */
        const attachBy = async (way, scope, field, png, name) => {
          if (way === 'button') {
            await scope
              .locator('[data-image-attach-input], [data-chat-attach-input]')
              .first()
              .setInputFiles({ name, mimeType: 'image/png', buffer: png });
            return;
          }
          const payload = { b64: png.toString('base64'), name, way };
          await field.evaluate((element, { b64, name: fileName, way: kind }) => {
            const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
            const data = new DataTransfer();
            data.items.add(new File([bytes], fileName, { type: 'image/png' }));
            if (kind === 'paste') {
              element.focus();
              element.dispatchEvent(
                new ClipboardEvent('paste', {
                  clipboardData: data,
                  bubbles: true,
                  cancelable: true,
                }),
              );
              return;
            }
            for (const type of ['dragenter', 'dragover', 'drop']) {
              element.dispatchEvent(
                new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
              );
            }
          }, payload);
        };

        const settle = () => page.waitForLoadState('domcontentloaded');

        /**
         * Открыть окно агента. Панель помнит, что оно было открыто, и после
         * перезагрузки поднимает его сама — кнопки тогда нет, ждать её нельзя.
         */
        const openAgent = async (timeout = 120_000) => {
          const win = page.locator('[data-panel-agent-window]');
          await page
            .locator('[data-panel-agent-window], [data-panel-agent-trigger]')
            .first()
            .waitFor({ timeout });
          if ((await win.count()) === 0) {
            await page.locator('[data-panel-agent-trigger]').evaluate((button) => button.click());
          }
          await win.waitFor({ timeout: 10_000 });
          return win;
        };

        /** Дождаться, что совпадений стало больше `before`: ответы прошлых ходов уже на экране. */
        const waitForMore = async (locator, before, timeoutMs = 20_000) => {
          for (let t = 0; t < timeoutMs / 250 && (await locator.count()) <= before; t += 1) {
            await wait(250);
          }
          return (await locator.count()) > before;
        };

        // ── 1. Агент панели ──────────────────────────────────────────────────
        if (wants('panel')) {
          await page.goto(`${stand.webUrl}/rules`);
          await settle();
          const win = await openAgent();
          const input = win.locator('[data-agent-input]');
          await input.waitFor();
          for (const { way, png } of PATHS) {
            const name = way === 'paste' ? 'image.png' : `${way}-${scheme}.png`;
            await attachBy(way, win, input, png, name);
            const chip = win.locator('[data-image-chip]');
            const attached = await chip
              .first()
              .waitFor({ timeout: 10_000 })
              .then(() => true)
              .catch(() => false);
            check(`агент панели, ${way}: чип появился`, attached);
            const chipName = attached ? await chip.first().getAttribute('data-image-chip') : '';
            if (way === 'paste') {
              check(
                'вставка: безымянный снимок получил имя pasted-…',
                /^pasted-\d{8}-\d{6}\.png$/.test(chipName ?? ''),
                chipName ?? '',
              );
            }
            if (way === 'button') await shot('panel-agent-attached');
            const since = calls().length;
            // Любой новый ответ, не только верный: мутант без картинки должен
            // краснеть сразу по тексту, а не ждать таймаута.
            const replies = win.getByText(/QA-AGENT: images=\d+/);
            const repliesBefore = await replies.count();
            await input.fill(`Что на снимке (${way})?`);
            await input.press('Enter');
            const call = await nextCall(since);
            check(`агент панели, ${way}: картинка дошла до CLI байт в байт`, sameImage(call, png));
            check(
              `агент панели, ${way}: реплика называет картинку по-английски`,
              Boolean(call?.text?.includes(`Attached images: ${chipName}`)),
            );
            const replied = await waitForMore(replies, repliesBefore);
            check(
              `агент панели, ${way}: ответ пришёл, чип снят, имя — в реплике`,
              replied &&
                (await replies.last().innerText()).includes('QA-AGENT: images=1') &&
                (await chip.count()) === 0 &&
                (await win.locator('[data-sent-images]').last().innerText()).includes(chipName),
            );
          }
          await shot('panel-agent-sent');
          // Следующий ход без картинки — прежняя не едет повторно.
          const since = calls().length;
          await input.fill('А без картинки?');
          await input.press('Enter');
          const plain = await nextCall(since);
          check(
            'агент панели: ход без картинки — без потокового ввода и без картинок',
            Boolean(plain) && plain.images.length === 0 && !plain.argv.includes('--input-format'),
          );
          await win
            .getByText('QA-AGENT: images=0')
            .last()
            .waitFor({ timeout: 20_000 })
            .catch(() => undefined);

          // Ужатие большого снимка.
          if (scheme === 'light') {
            await attachBy('button', win, input, PNG_BIG, 'big.png');
            await win.locator('[data-image-chip]').first().waitFor({ timeout: 20_000 });
            const sinceBig = calls().length;
            await input.fill('Большой снимок');
            await input.press('Enter');
            const big = await nextCall(sinceBig);
            const size = big?.images?.[0] ? dimensionsOf(big.images[0].data) : undefined;
            check(
              'снимок 3200×1800 ужат: длинная сторона ≤ 1568, пропорции те же',
              Boolean(size) &&
                Math.max(size.width, size.height) <= 1568 &&
                Math.abs(size.width / size.height - 3200 / 1800) < 0.01,
              JSON.stringify(size),
            );
            await win
              .getByText('QA-AGENT: images=1')
              .last()
              .waitFor({ timeout: 20_000 })
              .catch(() => undefined);
          }

          // Отказы — в момент вложения, словами.
          if (wants('refusals') && scheme === 'light') {
            const refusal = win.locator('[data-image-refusal]');
            await win.locator('[data-image-attach-input]').setInputFiles({
              name: 'notes.txt',
              mimeType: 'text/plain',
              buffer: Buffer.from('x'),
            });
            await refusal.waitFor({ timeout: 5_000 }).catch(() => undefined);
            check(
              'не картинка: отказ с именем файла',
              (await refusal.count()) > 0 && (await refusal.innerText()).includes('notes.txt'),
            );
            const huge = Buffer.alloc(21 * 1024 * 1024);
            PNG_A.copy(huge);
            await win
              .locator('[data-image-attach-input]')
              .setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: huge });
            await page
              .waitForFunction(
                () =>
                  document.querySelector('[data-image-refusal]')?.textContent?.includes('huge.png'),
                null,
                { timeout: 10_000 },
              )
              .catch(() => undefined);
            const hugeText = (await refusal.count()) > 0 ? await refusal.innerText() : '';
            check(
              'больше 20 МБ: отказ называет настоящий размер и предел',
              hugeText.includes('huge.png') && hugeText.includes('21') && hugeText.includes('20'),
              hugeText,
            );
            await shot('panel-agent-refusal');
            const nine = Array.from({ length: 9 }, (_, i) => ({
              name: `n${i}.png`,
              mimeType: 'image/png',
              buffer: PNG_C,
            }));
            await win.locator('[data-image-attach-input]').setInputFiles(nine);
            await page
              .waitForFunction(
                () => document.querySelectorAll('[data-image-chip]').length === 8,
                null,
                { timeout: 10_000 },
              )
              .catch(() => undefined);
            check(
              'девять картинок: приложено восемь, девятая названа в отказе',
              (await win.locator('[data-image-chip]').count()) === 8 &&
                (await refusal.innerText()).includes('n8.png'),
            );
            // Убрать всё крестиками — чипы снимаются по одному.
            for (let i = 0; i < 8; i += 1) {
              await win
                .getByRole('button', { name: /^Убрать картинку/ })
                .first()
                .click();
            }
            check(
              'чипы убираются крестиком',
              (await win.locator('[data-image-chip]').count()) === 0,
            );
          }
          await win
            .getByRole('button', { name: 'Закрыть', exact: true })
            .first()
            .click()
            .catch(() => undefined);
        }

        // ── 2. Помощник формы ────────────────────────────────────────────────
        if (wants('form')) {
          await page.goto(`${stand.webUrl}/rules`);
          await settle();
          await page
            .getByRole('button', { name: /Добавить правило/ })
            .first()
            .click();
          const input = page.locator('[data-assistant-input]');
          await input.waitFor({ timeout: 20_000 });
          const scope = page.getByRole('dialog').filter({ has: input });
          for (const { way, png } of PATHS) {
            await attachBy(way, scope, input, png, `form-${way}.png`);
            await scope
              .locator('[data-image-chip]')
              .first()
              .waitFor({ timeout: 10_000 })
              .catch(() => undefined);
            check(
              `помощник формы, ${way}: чип появился`,
              (await scope.locator('[data-image-chip]').count()) === 1,
            );
            if (way === 'button') await shot('form-assistant-attached');
            const since = calls().length;
            // Ответы прошлых путей уже на экране — ждём НОВЫЙ, а не любой.
            const replies = scope.getByText(/QA-FORM: images=\d+/);
            const repliesBefore = await replies.count();
            await input.fill(`заполни по снимку (${way})`);
            await input.press('Enter');
            const call = await nextCall(since);
            check(
              `помощник формы, ${way}: картинка дошла до CLI байт в байт`,
              sameImage(call, png),
            );
            check(
              `помощник формы, ${way}: ответ пришёл, чип снят`,
              (await waitForMore(replies, repliesBefore)) &&
                (await replies.last().innerText()).includes('QA-FORM: images=1') &&
                (await scope.locator('[data-image-chip]').count()) === 0,
              `ответов ${await replies.count()} (было ${repliesBefore}); ${(
                await scope
                  .first()
                  .innerText()
                  .catch(() => '')
              )
                .replace(/\s+/g, ' ')
                .slice(-300)}`,
            );
          }
          await shot('form-assistant-sent');
          await page.keyboard.press('Escape');
        }

        // ── 3. Помощник структуры ────────────────────────────────────────────
        if (wants('structure')) {
          await page.goto(`${stand.webUrl}/skills`);
          await settle();
          await page
            .getByRole('button', { name: 'Редактировать: qa-skill' })
            .first()
            .click({ timeout: 30_000 });
          const scope = page.locator('[data-structure-assistant]');
          await scope.waitFor({ timeout: 20_000 });
          const input = scope.locator('textarea');
          for (const { way, png } of PATHS) {
            await attachBy(way, scope, input, png, `tree-${way}.png`);
            await scope
              .locator('[data-image-chip]')
              .first()
              .waitFor({ timeout: 10_000 })
              .catch(() => undefined);
            check(
              `помощник структуры, ${way}: чип появился`,
              (await scope.locator('[data-image-chip]').count()) === 1,
            );
            if (way === 'button') {
              await scope.scrollIntoViewIfNeeded();
              await shot('structure-assistant-attached');
            }
            const since = calls().length;
            await input.fill(`собери по схеме (${way})`);
            await scope.getByRole('button', { name: 'Собрать' }).click();
            const call = await nextCall(since);
            check(
              `помощник структуры, ${way}: картинка дошла до CLI байт в байт`,
              sameImage(call, png),
            );
            // Ответ прошлого пути остаётся на экране, а чип снимается только при
            // успехе — конец хода виден по снятому чипу, не по тексту ответа.
            const chips = scope.locator('[data-image-chip]');
            for (let t = 0; t < 80 && (await chips.count()) > 0; t += 1) await wait(250);
            check(
              `помощник структуры, ${way}: ответ пришёл, чип снят`,
              (await scope.getByText('QA-STRUCTURE: images=1').count()) > 0 &&
                (await scope.locator('[data-image-chip]').count()) === 0,
            );
          }
          // Отказ сервера (F-175): причина словами сервера одной строкой у
          // помощника, а не общий «не сохранилось» плюс тост с той же причиной.
          const reason = 'Картинок больше восьми — приложите не больше восьми.';
          await page.route('**/api/resources/**/assist', (route) =>
            route.fulfill({ status: 400, json: { error: reason } }),
          );
          await input.fill('собери по схеме (отказ)');
          await scope.getByRole('button', { name: 'Собрать' }).click();
          await scope
            .getByText(reason)
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          await wait(800);
          const inScope = await scope.getByRole('alert').filter({ hasText: reason }).count();
          const onPage = await page.getByText(reason).count();
          check(
            `помощник структуры: отказ сервера назван у помощника и один раз (${inScope}/${onPage})`,
            inScope === 1 && onPage === 1,
          );
          await shot('structure-assistant-refused');
          await page.unroute('**/api/resources/**/assist');
          await page.keyboard.press('Escape');
        }

        // ── 4. Ассистент шага группы ─────────────────────────────────────────
        if (wants('step')) {
          await page.goto(`${stand.webUrl}/groups`);
          await settle();
          const opener = page
            .getByRole('heading', { name: 'QA Images', exact: true })
            .getByRole('button', { name: 'QA Images', exact: true });
          await opener.first().click({ timeout: 30_000 });
          const dialog = page.getByRole('dialog', { name: 'QA Images', exact: true });
          await dialog.waitFor({ timeout: 15_000 });
          await dialog
            .getByRole('button', { name: /^Добавить шаг/ })
            .first()
            .click({ timeout: 15_000 });
          const composer = page.getByRole('dialog', { name: 'Новый шаг' });
          await composer.waitFor({ timeout: 15_000 });
          const input = composer.locator('textarea').first();
          for (const { way, png } of PATHS) {
            await attachBy(way, composer, input, png, `step-${way}.png`);
            await composer
              .locator('[data-image-chip]')
              .first()
              .waitFor({ timeout: 10_000 })
              .catch(() => undefined);
            check(
              `ассистент шага, ${way}: чип появился`,
              (await composer.locator('[data-image-chip]').count()) === 1,
            );
            if (way === 'button') await shot('step-composer-attached');
            const since = calls().length;
            await input.fill(`шаг как на снимке (${way})`);
            await composer
              .getByRole('button', { name: /^(Подготовить|Ответить)$/ })
              .first()
              .click();
            const call = await nextCall(since);
            check(
              `ассистент шага, ${way}: картинка дошла до CLI байт в байт`,
              sameImage(call, png),
            );
            await page
              .waitForFunction(
                () => !document.querySelector('[role="dialog"] [aria-busy="true"]'),
                null,
                { timeout: 20_000 },
              )
              .catch(() => undefined);
            check(
              `ассистент шага, ${way}: имя картинки в ленте, чип снят`,
              (await composer.locator('[data-sent-images]').last().innerText()).includes(
                `step-${way}.png`,
              ) && (await composer.locator('[data-image-chip]').count()) === 0,
            );
          }
          await shot('step-composer-sent');
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
        }

        // ── 5. Чат чужого CLI ────────────────────────────────────────────────
        if (wants('foreign')) {
          const foreign = await context.newPage();
          const sends = [];
          const json = (route, body) =>
            route.fulfill({ status: 200, json: body }).catch(() => undefined);
          const chat = {
            id: 'qa-f',
            providerId: 'codex',
            title: 'QA',
            createdAt: '2026-09-27T10:00:00.000Z',
            updatedAt: '2026-09-27T10:00:00.000Z',
            messageCount: 0,
          };
          await foreign.route('**/api/settings', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            const response = await route.fetch();
            await route.fulfill({
              response,
              json: { ...(await response.json()), provider: 'codex' },
            });
          });
          await foreign.route('**/api/provider-runner', (route) =>
            json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
          );
          await foreign.route('**/api/provider-chat/chats', (route) => json(route, [chat]));
          await foreign.route('**/api/provider-chat/chats/qa-f/status', (route) =>
            json(route, { chatId: 'qa-f', isRunning: false, partial: '' }),
          );
          await foreign.route('**/api/provider-chat/chats/qa-f/send', async (route) => {
            const body = route.request().postDataJSON();
            sends.push(body);
            await json(route, {
              message: {
                id: `u${sends.length}`,
                role: 'user',
                content: body.text,
                at: new Date().toISOString(),
              },
            });
          });
          await foreign.route('**/api/provider-chat/chats/qa-f/stream', (route) =>
            route
              .fulfill({
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
              })
              .catch(() => undefined),
          );
          await foreign.route('**/api/provider-chat/chats/qa-f', (route) =>
            json(route, { ...chat, messages: [] }),
          );
          await foreign.goto(`${stand.webUrl}/chat`);
          const input = foreign.getByRole('textbox', { name: /Сообщение провайдеру/ });
          await input.waitFor({ timeout: 120_000 });
          const scope = foreign.locator('body');
          for (const { way, png } of PATHS) {
            await attachBy(way, scope, input, png, `foreign-${way}.png`);
            await scope
              .locator('[data-image-chip]')
              .first()
              .waitFor({ timeout: 10_000 })
              .catch(() => undefined);
            check(
              `чат чужого CLI, ${way}: чип появился`,
              (await scope.locator('[data-image-chip]').count()) === 1,
            );
            if (way === 'button' && SHOTS) {
              await foreign.screenshot({
                path: join(SHOTS, `foreign-chat-attached_${scheme}.png`),
              });
            }
            const before = sends.length;
            await input.fill(`что на снимке (${way})`);
            await input.press('Enter');
            for (let t = 0; t < 40 && sends.length === before; t += 1) await wait(250);
            const paths = sends.at(-1)?.attachments ?? [];
            const stored = paths.find((path) => /agent-images/.test(path));
            check(
              `чат чужого CLI, ${way}: панель положила файл, путь — во вложениях отправки`,
              Boolean(stored) && existsSync(stored) && readFileSync(stored).equals(png),
              JSON.stringify(paths),
            );
          }
          await foreign.close();
        }

        // ── 6. Чат Claude: вставка — новый путь, кнопка и перетаскивание — прежние ──
        if (wants('chat')) {
          const chatPage = await context.newPage();
          const posts = [];
          chatPage.on('request', (request) => {
            if (request.method() === 'POST' && /\/api\/chat\//.test(request.url())) {
              try {
                posts.push(request.postDataJSON());
              } catch {
                // не JSON
              }
            }
          });
          await chatPage.goto(`${stand.webUrl}/chat`);
          const input = chatPage.locator('textarea[data-chat-input]');
          await input.waitFor({ timeout: 90_000 });
          const blocking = chatPage.getByRole('dialog').filter({ hasText: 'нужен доступ' });
          await blocking
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          if ((await blocking.count()) > 0) {
            await blocking.first().getByRole('button', { name: 'Закрыть' }).first().click();
          }
          const scope = chatPage.locator('body');
          for (const { way, png } of PATHS) {
            // Снимок из буфера приходит безымянным `image.png` — чат даёт ему имя pasted-…
            const name = way === 'paste' ? 'image.png' : `chat-${way}.png`;
            await attachBy(way, scope, input, png, name);
            const chipName = way === 'paste' ? /^Удалить: pasted-/ : `Удалить: ${name}`;
            const chip = chatPage.getByRole('button', { name: chipName });
            await chip
              .first()
              .waitFor({ timeout: 10_000 })
              .catch(() => undefined);
            check(`чат Claude, ${way}: чип вложения появился`, (await chip.count()) === 1);
            const before = posts.length;
            await input.fill(`что на снимке (${way})`);
            await input.press('Enter');
            // Ждём именно отправку с файлами: другой POST чата (служебный) мог
            // прийти раньше и закончить ожидание пустым.
            const sent = () => posts.slice(before).flatMap((body) => body?.files ?? []);
            for (let t = 0; t < 40 && sent().length === 0; t += 1) await wait(250);
            const files = sent();
            check(
              `чат Claude, ${way}: картинка ушла в теле отправки байт в байт`,
              files.some((file) => file.base64 === png.toString('base64')),
              JSON.stringify({
                posts: posts.length - before,
                files: files.map((file) => file.name),
                chips: await chatPage.locator('[aria-label^="Удалить: "]').count(),
              }),
            );
            await chatPage.waitForTimeout(500);
          }
          await chatPage.close();
        }

        // ── 7. Ширина окна агента ────────────────────────────────────────────
        if (wants('resize') && scheme === 'light') {
          await page.goto(`${stand.webUrl}/rules`);
          await settle();
          await page.evaluate(() => localStorage.removeItem('agentdeck:panel-agent-dock-width'));
          await page.reload();
          const win = await openAgent();
          const handle = page.getByRole('separator', { name: 'Ширина окна агента' });
          await handle.waitFor({ timeout: 10_000 });
          const dockWidth = async () => Math.round((await win.boundingBox()).width);
          check('по умолчанию 440 px', (await dockWidth()) === 440, String(await dockWidth()));
          check(
            'разделитель объявляет ширину',
            (await handle.getAttribute('aria-valuenow')) === '440',
          );

          await handle.focus();
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.press('ArrowLeft');
          await wait(200);
          check(
            'стрелка влево ×2 расширяет на 48 px',
            (await dockWidth()) === 488,
            String(await dockWidth()),
          );

          const box = await handle.boundingBox();
          const y = box.y + box.height / 2;
          const x = box.x + box.width / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x - 50, y, { steps: 5 });
          await page.mouse.move(x - 100, y, { steps: 5 });
          await page.mouse.up();
          await wait(200);
          const dragged = await dockWidth();
          check(
            'перетаскивание на 100 px влево — окно шире на 100',
            Math.abs(dragged - 588) <= 2,
            String(dragged),
          );
          const shifted = await page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--panel-agent-dock-inset')
              .trim(),
          );
          check('страница сдвинута на ту же ширину', shifted === `${dragged}px`, shifted);
          await shot('dock-resized');

          await page.reload();
          await openAgent();
          await handle.waitFor({ timeout: 10_000 });
          check(
            'ширина пережила перезагрузку',
            Math.abs((await dockWidth()) - dragged) <= 2,
            String(await dockWidth()),
          );

          const far = await handle.boundingBox();
          await page.mouse.move(far.x + far.width / 2, far.y + far.height / 2);
          await page.mouse.down();
          await page.mouse.move(far.x - 2000, y, { steps: 10 });
          await page.mouse.up();
          await wait(200);
          check(
            'шире предела нельзя: 1400 − 480 = 920',
            (await dockWidth()) === 920,
            String(await dockWidth()),
          );
          // Запомнена та же ширина, что на экране, и разделитель объявляет предел:
          // иначе на широком мониторе окно раскрылось бы до «запомненных» 2000+.
          const stored = await page.evaluate(() =>
            localStorage.getItem('agentdeck:panel-agent-dock-width'),
          );
          check(
            'запомнено 920, предел объявлен 920',
            stored === '920' && (await handle.getAttribute('aria-valuemax')) === '920',
            `${stored} / ${await handle.getAttribute('aria-valuemax')}`,
          );
          await page.keyboard.press('ArrowRight');
          const near = await handle.boundingBox();
          await page.mouse.move(near.x + near.width / 2, near.y + near.height / 2);
          await page.mouse.down();
          await page.mouse.move(near.x + 2000, y, { steps: 10 });
          await page.mouse.up();
          await wait(200);
          check('уже 360 нельзя', (await dockWidth()) === 360, String(await dockWidth()));

          await page.setViewportSize({ width: 800, height: 900 });
          await wait(300);
          check('узкий экран: ручки нет', (await handle.count()) === 0);
          check(
            'узкий экран: окно прежней ширины 440',
            (await dockWidth()) === 440,
            String(await dockWidth()),
          );
          await page.setViewportSize({ width: 1400, height: 950 });
          await wait(300);
          check(
            'снова широкий: сохранённая ширина вернулась',
            (await dockWidth()) === 360,
            String(await dockWidth()),
          );
        }

        check(`тема ${scheme}: без ошибок страницы`, errors.length === 0, errors.join(' | '));
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
