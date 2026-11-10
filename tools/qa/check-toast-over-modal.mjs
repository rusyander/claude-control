/**
 * Уведомление поверх модального окна (`shared/ui/toast`, этап 12) — живой фронт `pnpm dev`: окно
 * создания правила (настоящий `Modal` на Radix), уведомление — настоящий стор тостов приложения
 * (тот же модуль Vite, что у страницы). Ничего не сохраняется: окно закрывается без записи.
 *
 * Что видно:
 *   - тост при открытом окне не накрывает ни одной кнопки окна (подвал «Сохранить»/«Отмена»);
 *   - тост, появившийся под неподвижным курсором, уходит сам по сроку — пауза только от движения
 *     указателя по тосту; наведённый тост держится, увёл указатель — уходит;
 *   - тост доступен с клавиатуры из окна: не под `aria-hidden`, Tab из окна доходит до его кнопки
 *     «Закрыть», нажатие закрывает тост, а окно остаётся открытым;
 *   - открытая всплывашка (выбор периода в аналитике) окном не считается: тост остаётся на странице.
 *
 * Запуск: `node tools/qa/check-toast-over-modal.mjs` при поднятом `pnpm dev` (`APP_URL` — другой
 * фронт). `SHOTS=<dir>` — кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER`. Код выхода: 0 — сходится,
 * 1 — провал, 2 — не проверено.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

/** Тост из стора приложения: тот же модуль, что импортирует страница (`@shared/lib/toast`). */
const fire = (page, message, duration) =>
  page.evaluate(
    async ({ message: text, duration: ms }) => {
      const mod = await import('/src/shared/lib/toast/index.ts');
      mod.toast.error(text, { duration: ms });
    },
    { message, duration },
  );

const toastLi = (page, text) => page.locator('li', { hasText: text }).first();

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await bypassOnboarding(page);
  const res = await page.goto(`${BASE}/rules`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (!res) {
    console.log(`НЕ ПРОВЕРЕНО: фронт ${BASE} не отвечает`);
    process.exit(2);
  }
  const create = page.getByRole('button', { name: /Добавить правило|Add rule/ });
  await create.first().waitFor({ timeout: 30_000 });
  await create.first().click();
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await wait(500);

  // 1. Место: тост не накрывает кнопок окна.
  await fire(page, 'Проверка: отказ отправки', 0);
  const one = toastLi(page, 'Проверка: отказ отправки');
  await one.waitFor({ timeout: 5000 });
  await wait(400);
  const covered = await page.evaluate((text) => {
    const li = [...document.querySelectorAll('li')].find((el) => el.textContent?.includes(text));
    const box = li?.getBoundingClientRect();
    const dlg = document.querySelector('[role="dialog"]');
    if (!box || !dlg) return ['нет тоста или окна'];
    return [...dlg.querySelectorAll('button, a[href], input, textarea, select')]
      .filter((el) => !li.contains(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      })
      .map((el) => (el.textContent || el.getAttribute('aria-label') || el.tagName).trim());
  }, 'Проверка: отказ отправки');
  check(
    `тост не накрывает кнопок окна (${covered.join(', ') || 'ни одной'})`,
    covered.length === 0,
  );
  await shoot(page, 'toast-over-modal');

  // 3. Клавиатура: не под aria-hidden, Tab из окна доходит до «Закрыть» тоста.
  const hidden = await one.evaluate((el) => Boolean(el.closest('[aria-hidden="true"]')));
  check('тост не под aria-hidden окна', !hidden);
  await dialog.locator('input, textarea, button').first().focus();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await one.evaluate((el) => el.contains(document.activeElement));
  }
  check('Tab из окна доходит до кнопки тоста', reached);
  if (reached) {
    const focusedName = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? '',
    );
    if (!/Закрыть|Close/.test(focusedName)) {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Tab');
        const name = await page.evaluate(
          () => document.activeElement?.getAttribute('aria-label') ?? '',
        );
        if (/Закрыть|Close/.test(name)) break;
      }
    }
    await page.keyboard.press('Enter');
    check(
      'Enter на «Закрыть» убирает тост',
      await one.waitFor({ state: 'detached', timeout: 3000 }).then(
        () => true,
        () => false,
      ),
    );
    check('окно осталось открытым', await dialog.isVisible());
  }

  // 2. Пауза: тост под неподвижным курсором уходит сам.
  await fire(page, 'Проверка: под курсором', 0);
  const probe = toastLi(page, 'Проверка: под курсором');
  await probe.waitFor({ timeout: 5000 });
  await wait(400);
  const spot = await probe.boundingBox();
  await probe.evaluate((el) => el.querySelector('button[aria-label]')?.click());
  await probe.waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
  if (spot) await page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2);
  await wait(300);
  await fire(page, 'Проверка: курсор стоит', 1500);
  const still = toastLi(page, 'Проверка: курсор стоит');
  await still.waitFor({ timeout: 5000 });
  check(
    'тост под неподвижным курсором ушёл сам по сроку',
    await still.waitFor({ state: 'detached', timeout: 6000 }).then(
      () => true,
      () => false,
    ),
  );
  await fire(page, 'Проверка: наведён', 1500);
  const hovered = toastLi(page, 'Проверка: наведён');
  await hovered.waitFor({ timeout: 5000 });
  const hb = await hovered.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + 10, hb.y + 10);
    await page.mouse.move(hb.x + 20, hb.y + 12, { steps: 3 });
  }
  await wait(2500);
  check('наведённый тост держится', (await hovered.count()) === 1);
  await page.mouse.move(5, 5, { steps: 3 });
  check(
    'увёл указатель — тост ушёл',
    await hovered.waitFor({ state: 'detached', timeout: 6000 }).then(
      () => true,
      () => false,
    ),
  );

  await page.keyboard.press('Escape');

  // 4. Всплывашка — не окно: у Radix Popover тоже role="dialog" и data-state="open", но она не
  // модальна, а её обёртка сдвинута transform — тост внутри неё встал бы у всплывашки и исчез с ней.
  await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
  const picker = page.getByRole('button', { name: /Произвольный период|Custom period/ }).first();
  await picker.waitFor({ timeout: 30_000 });
  await picker.click();
  await page.locator('[data-radix-popper-content-wrapper] [role="dialog"]').first().waitFor({
    timeout: 5000,
  });
  await fire(page, 'Проверка: всплывашка открыта', 0);
  const pop = toastLi(page, 'Проверка: всплывашка открыта');
  await pop.waitFor({ timeout: 5000 });
  const where = await pop.evaluate((el) => ({
    host: el.closest('[data-toast-host]')?.getAttribute('data-toast-host') ?? '',
    inPopper: Boolean(el.closest('[data-radix-popper-content-wrapper]')),
  }));
  check(
    `при открытой всплывашке тост на странице, не в ней (${JSON.stringify(where)})`,
    where.host === 'page' && !where.inPopper,
  );
  await pop.evaluate((el) => el.querySelector('button[aria-label]')?.click());
  await page.keyboard.press('Escape');
} finally {
  await browser.close();
}
console.log(failed ? `\nПровалов: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
