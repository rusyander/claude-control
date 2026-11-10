/**
 * Поле «Репозитории для задач из Telegram» не перетирает чужую правку (этап 12, W2-D): окно пишет
 * `telegram.repos` от того вида настройки ядра, который человек видел (`baseDigest` открытого
 * вида), а не от перечитанного перед записью. Настройку изменили между чтением и «Сохранить» —
 * ядро отвечает 409 (`stale-digest`), окно показывает причину и «Перечитать настройку»; чужие
 * репозитории целы. Перечитал — поле показывает свежие, запись проходит.
 *
 * Подмена — `telegram-card-stub.mjs` (карточка «подключена», ядро с судом отпечатка); Bot API и
 * настоящая настройка ядра не нужны, ничего не пишется. Стенд — `pnpm dev` (:8888).
 * Запуск: `node tools/qa/check-telegram-repos.mjs`. `SHOTS=<dir>` — кадры (`SHOT_TAG`).
 * Код выхода: 0 — сходится, 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import {
  installTelegramCardStub,
  TELEGRAM_FINGERPRINT,
  TELEGRAM_REPOS,
} from './telegram-card-stub.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

/** Правка «другой вкладки»: второй репозиторий, записанный мимо этого окна. */
const OTHER_REPOS = [...TELEGRAM_REPOS, { path: 'C:/work/other-lib', baseRef: null }];
const MINE = 'C:/work/mine @ dev';

let bad = 0;
const rows = [];
const check = (text, ok, detail = '') => {
  if (!ok) bad += 1;
  rows.push({ check: text, verdict: ok ? 'ok' : 'FAIL', detail: ok ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `\n      ${detail}` : ''}`);
  return ok;
};

const has = async (locator, timeout = 5_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('[data-telegram-repos]').scrollIntoViewIfNeeded();
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

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(8_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await bypassOnboarding(page);
    // Маскот выключен: его приветствие ложится поверх кнопки поля и перехватывает нажатие.
    await page.addInitScript(() =>
      localStorage.setItem(
        'agentdeck.mascot',
        JSON.stringify({ enabled: false, chatty: false, greeted: true, reactions: false }),
      ),
    );
    const state = await installTelegramCardStub(page);
    await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
    const block = page.locator('[data-telegram-repos]');
    const field = block.getByLabel('Репозитории для задач из Telegram');
    const save = block.getByRole('button', { name: 'Сохранить репозитории' });
    check('поле репозиториев на подключённой карточке видно', await has(block, 20_000));
    check(
      'поле показывает действующую настройку',
      (await field.inputValue()) === 'C:/work/demo-app @ main',
      await field.inputValue(),
    );
    const seenDigest = await page.evaluate(async () => {
      const r = await fetch('/api/core/config');
      return (await r.json()).digest;
    });

    // Другая вкладка записала свой репозиторий, пока это окно открыто.
    state.doc = { telegram: { owner: TELEGRAM_FINGERPRINT, repos: OTHER_REPOS } };
    await field.fill(MINE);
    await save.click();
    const failed = block.locator('[data-telegram-repos-error]');
    const reload = block.locator('[data-telegram-repos-reload]');
    await has(failed);
    check(
      'запись идёт от увиденного вида (baseDigest открытого окна), а не от перечитанного',
      state.configs[0]?.baseDigest === seenDigest,
      `${state.configs[0]?.baseDigest} vs ${seenDigest}`,
    );
    check(
      'чужая правка цела: репозитории другой вкладки не перетёрты',
      JSON.stringify(state.doc.telegram.repos) === JSON.stringify(OTHER_REPOS),
      JSON.stringify(state.doc.telegram),
    );
    check(
      'ядро ответило 409 — причина под полем и «Перечитать настройку»',
      (await has(failed.getByText('Настройку уже изменили', { exact: false }))) &&
        (await has(reload)),
      (await failed.textContent().catch(() => ''))?.slice(0, 200),
    );
    await shoot(page, 'telegram-repos-stale');

    // Отказ обновил кэш настройки — повторное «Сохранить» без перечитывания всё равно судится видом,
    // от которого начат черновик: чужая правка цела и во второй раз.
    await page.waitForTimeout(500);
    await save.click();
    await page.waitForTimeout(800);
    check(
      'повторное «Сохранить» без перечитывания — снова 409, чужая правка цела',
      state.configs.length === 2 &&
        state.configs[1]?.baseDigest === seenDigest &&
        JSON.stringify(state.doc.telegram.repos) === JSON.stringify(OTHER_REPOS) &&
        (await has(reload)),
      JSON.stringify({ n: state.configs.length, doc: state.doc.telegram }),
    );

    await reload.click();
    // Перечитывание асинхронно: кнопка уходит, когда свежая настройка приехала и черновик снят.
    await reload.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    check(
      '«Перечитать настройку» — поле показывает свежие репозитории, причина снята',
      (await field.inputValue()) === 'C:/work/demo-app @ main\nC:/work/other-lib' &&
        (await failed.count()) === 0,
      await field.inputValue(),
    );
    await field.fill(MINE);
    await save.click();
    await page.waitForTimeout(500);
    check(
      'после перечитывания запись проходит; владелец не тронут',
      JSON.stringify(state.doc.telegram.repos) ===
        JSON.stringify([{ path: 'C:/work/mine', baseRef: 'dev' }]) &&
        state.doc.telegram.owner === TELEGRAM_FINGERPRINT &&
        (await failed.count()) === 0,
      JSON.stringify(state.doc.telegram),
    );
    check('ошибок страницы нет', errors.length === 0, errors.join(' | '));
  } catch (error) {
    // Нет элемента или таймаут — строка провала в таблице, а не голое исключение.
    check(
      'сценарий дошёл до конца',
      false,
      String(error?.message ?? error)
        .split('\n')
        .slice(0, 12)
        .join(' | '),
    );
  } finally {
    await browser.close();
  }
  console.table(rows);
  console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
