/**
 * Связанные карточки доски ядра (этап 12, B11, D26, P186) — живой фронт `pnpm dev`, ответы ядра
 * подменены `page.route` (`installCoreBoardStub(page, { related: true })`): живой журнал ядра пары
 * связанных тикетов не держит. Подмена — граница сети: значок, раздел окна, ход и отказ рисует
 * настоящий код панели из ответа формы `BoardReply` и тела отказа `board-move.ts`.
 *
 * Что видно:
 *   - плитка PROJ-10 несёт значок «связано: 1», несвязанная запись очереди — нет;
 *   - окно записи: раздел «Связанные карточки», PROJ-11 отмечена по умолчанию, причины словами;
 *   - Space снимает и возвращает отметку, без отметок «Объединить» заперта;
 *   - отказ ядра 409 (запись ушла в очередь) сказан ОДИН раз — в окне, по-русски и с ключом тикета,
 *     без английской прозы ядра на экране (она — только подсказкой) и без копии общим тостом;
 *   - принятое объединение: ровно один ход `{to:'merge', entryId, entryIds:[PROJ-11], proof}`,
 *     доска перечитана, плитки PROJ-11 нет, раздел ушёл; ошибок страницы нет.
 *
 * Запуск: `node tools/qa/check-core-related.mjs` при поднятом `pnpm dev` (`APP_URL` — другой
 * фронт). `SHOTS=<dir>` — кадры окна с отказом в обеих темах (`SHOT_TAG`, по умолчанию AFTER).
 * Код выхода: 0 — сходится, 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import {
  BOARD_IDS,
  BOARD_RELATED_ID,
  MERGE_REFUSAL_REASON,
  installCoreBoardStub,
} from './check-core-board.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

let bad = 0;
const check = (text, ok, detail = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `\n      ${detail}` : ''}`);
  return ok;
};

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await bypassOnboarding(page);
  const state = await installCoreBoardStub(page, { related: true });

  // 1. Значок на плитке — только у связанной записи.
  await page.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-core-board]').waitFor({ timeout: 20_000 });
  const tile = page.locator(`[data-board-card="${BOARD_IDS.inbox}"]`);
  await tile.waitFor({ timeout: 10_000 });
  check(
    'плитка PROJ-10 — значок «связано: 1»',
    (await tile.locator('[data-board-related="1"]').count()) === 1 &&
      (await tile.innerText()).includes('связано: 1'),
  );
  check(
    'несвязанная запись очереди — без значка',
    (await page.locator(`[data-board-card="${BOARD_IDS.queued}"] [data-board-related]`).count()) ===
      0,
  );

  // 2. Окно записи: раздел, отметка по умолчанию, причины словами.
  await tile.click();
  const modal = page.locator(`[data-card-modal="${BOARD_IDS.inbox}"]`);
  await modal.waitFor({ timeout: 10_000 });
  const section = modal.locator('[data-related-merge]');
  await section.waitFor({ timeout: 5000 });
  const box = section.locator(`[data-related-item="${BOARD_RELATED_ID}"] input[type="checkbox"]`);
  check('PROJ-11 отмечена по умолчанию', await box.isChecked());
  check(
    'причины словами: общий эпик и общий путь',
    (await section.innerText()).includes('общий эпик или родитель, общий путь в обоих тикетах'),
  );

  // 3. Клавиатура: Space снимает и возвращает отметку.
  const submit = section.locator('[data-related-merge-submit]');
  await box.focus();
  await page.keyboard.press('Space');
  check(
    'Space снял отметку — «Объединить» заперта',
    !(await box.isChecked()) && (await submit.isDisabled()),
  );
  await page.keyboard.press('Space');
  check(
    'Space вернул отметку — «Объединить в эту (1)»',
    (await box.isChecked()) && (await submit.innerText()).includes('(1)'),
  );

  // 4. Отказ ядра 409: один раз, в окне, по-русски, ключ тикета, без английской прозы.
  state.mergeRefusal = true;
  await submit.focus();
  await page.keyboard.press('Enter');
  const refused = section.locator('[data-related-merge-refused]');
  await refused.waitFor({ timeout: 5000 }).catch(() => undefined);
  const refusedText = (await refused.innerText().catch(() => '')).trim();
  check('отказ виден в окне', refusedText !== '', refusedText);
  check('отказ называет тикет PROJ-11', refusedText.includes('PROJ-11'), refusedText);
  check(
    'на экране нет английской прозы ядра',
    !/only inbox entries merge|is queued|entry [0-9a-f-]{8}/.test(refusedText),
    refusedText,
  );
  check(
    'отказ сказан по-русски: «уже не во «Входящих»»',
    refusedText.includes('уже не во «Входящих»'),
    refusedText,
  );
  check(
    'проза ядра — подсказкой отказа',
    (await refused.getAttribute('title')) === MERGE_REFUSAL_REASON,
    String(await refused.getAttribute('title')),
  );
  await page.waitForTimeout(600);
  const toasts = await page
    .locator('[data-toast-host]')
    .getByText(/Ход доски не разрешён|Объединение не принято|PROJ-11/)
    .count();
  check('без копии общим тостом', toasts === 0, `тостов ${toasts}`);
  await shoot(page, 'modal-refused');

  // 5. Принятое объединение: один ход, доска перечитана, пара ушла.
  state.mergeRefusal = false;
  const before = state.moves.length;
  await submit.click();
  await page
    .locator(`[data-board-card="${BOARD_RELATED_ID}"]`)
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined);
  const sent = state.moves.slice(before);
  const body = sent[0] ?? {};
  check(
    'ровно один ход merge с отмеченной записью и доказательством страницы',
    sent.length === 1 &&
      body.to === 'merge' &&
      body.entryId === BOARD_IDS.inbox &&
      JSON.stringify(body.entryIds) === JSON.stringify([BOARD_RELATED_ID]) &&
      body.proof?.nonce === 'qa-board-nonce' &&
      typeof body.cmdId === 'string',
    JSON.stringify(sent),
  );
  check(
    'доска перечитана: плитки PROJ-11 нет',
    (await page.locator(`[data-board-card="${BOARD_RELATED_ID}"]`).count()) === 0,
  );
  check('раздел «Связанные карточки» ушёл', (await section.count()) === 0);
  check('ошибок страницы нет', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
