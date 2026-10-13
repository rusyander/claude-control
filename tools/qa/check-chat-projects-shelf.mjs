/**
 * Кейс chat-038: проекты чата и страница «Проекты» — одна полка
 * (владелец, 13.10.2026).
 *
 * - Список «Проекты» в чате: проекты со страницы «Проекты» стоят первыми и с
 *   меткой, даже без единого разговора; остальные добавляются туда кнопкой «+»
 *   в строке — и строка сразу получает метку.
 * - «Открыть несколько»: отмеченные проекты открываются вкладками разом, уже
 *   открытые в окне отмечены и выключены.
 * - Закрытая вкладка проекта со страницы «Проекты» не теряется: он остаётся в
 *   списке, хотя истории разговоров у него нет.
 * - Ряд проекта в шапке: «В «Проекты»» добавляет проект вкладки, после чего
 *   кнопка становится «В «Проектах»» и ведёт к его настройкам.
 * - Окно выбора на ширине телефона не вылезает за экран; axe без нарушений в
 *   обеих темах.
 *
 * Путь настоящий: одноразовая панель над временным домом, транскрипты засеяны
 * файлами, реестр — настоящий `POST /api/projects`. Оракул записи — реестр
 * панели (`GET /api/projects`), а не только экран. Реестр человека не
 * затрагивается.
 *
 * Запуск: `node tools/qa/check-chat-projects-shelf.mjs` (стенд поднимается сам);
 * `SHOTS=<папка>` — снимки.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const HIST_A = 'qa-hist-alpha';
const HIST_C = 'qa-hist-gamma';
const REG_B = 'qa-reg-beta';

/** Транскрипт Claude Code, чей `cwd` — папка проекта: так проект попадает в историю. */
function seedTranscript(cfg, slug, cwd) {
  const dir = join(cfg, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      uuid: `${slug}-u1`,
      sessionId: slug,
      timestamp: new Date().toISOString(),
      cwd,
      message: { role: 'user', content: 'привет' },
    })}\n`,
  );
}

await runOnStand(
  {
    label: 'chat-projects-shelf',
    // Тема по системе — тогда `emulateMedia` переключает её и axe меряет тёмную.
    settings: { theme: 'system' },
    seed: ({ home, cfg }) => {
      for (const name of [HIST_A, HIST_C, REG_B]) mkdirSync(join(home, name), { recursive: true });
      seedTranscript(cfg, 'enc-alpha', join(home, HIST_A));
      seedTranscript(cfg, 'enc-gamma', join(home, HIST_C));
    },
  },
  async (stand, check) => {
    const origin = new URL(stand.webUrl).origin;
    const registry = async () => (await stand.api('/projects')).body ?? [];
    // Имя записи — подпись строки истории («home/…»), поэтому сверка по концу пути.
    const names = async () =>
      (await registry()).map((item) => item.path.split(/[\\/]/).at(-1)).sort();
    const settle = async (predicate) => {
      for (let i = 0; i < 40; i += 1) {
        if (await predicate()) return true;
        await wait(150);
      }
      return false;
    };

    const added = await stand.api('/projects', {
      method: 'POST',
      headers: { origin },
      body: { path: join(stand.home, REG_B), name: REG_B },
    });
    check('проект B заведён на странице «Проекты»', added.status === 200, added.text.slice(0, 300));

    const browser = await chromium.launch();
    try {
      // axe работает только со страницей из явного контекста браузера.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const shot = async (name) => {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
      };
      const workspace = page.getByRole('tablist', { name: 'Рабочие пространства' });
      const sidebar = page.getByRole('tablist', { name: 'Чаты или проекты' });
      const openHomeProjects = async () => {
        const home = workspace.getByRole('tab', { name: 'Чаты' });
        if (await home.isVisible().catch(() => false)) await home.click();
        await sidebar.getByRole('tab', { name: 'Проекты' }).click();
        await page.getByRole('button', { name: 'Открыть несколько' }).waitFor({ timeout: 15_000 });
      };
      const rowOf = (name) =>
        page.locator('div', { has: page.getByTitle(new RegExp(`${name}$`)) }).last();
      const markOf = (name) => rowOf(name).getByRole('img', { name: 'Есть на странице «Проекты»' });
      const plusOf = (name) =>
        page.getByRole('button', { name: new RegExp(`^Добавить «[^»]*${name}» на страницу`) });

      // Стенд без CLI и ключа — гейт ассистента встаёт модалкой на каждой
      // загрузке чата; к проверке он не относится.
      const openChat = async () => {
        await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('nav', { timeout: 30_000 });
        const gate = page.getByRole('dialog', { name: /нужен доступ/ });
        const shown = await gate.waitFor({ timeout: 5000 }).then(
          () => true,
          () => false,
        );
        if (!shown) return;
        await gate.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
        await gate.waitFor({ state: 'hidden' });
      };

      await openChat();
      await openHomeProjects();
      await page
        .getByTitle(new RegExp(`${HIST_A}$`))
        .first()
        .waitFor({ timeout: 20_000 });
      await shot('01-list');

      // ── Список: проекты страницы «Проекты» первыми и с меткой ─────────────
      const order = await page
        .locator('button[title]')
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute('title') ?? '').filter((t) => /qa-/.test(t)),
        );
      check(
        'проект B без разговоров стоит в списке первым',
        order[0]?.endsWith(REG_B) === true,
        JSON.stringify(order),
      );
      check('у B метка «Есть на странице «Проекты»»', (await markOf(REG_B).count()) === 1);
      check('у B нет кнопки «+»', (await plusOf(REG_B).count()) === 0);
      check(
        'у A есть кнопка «+», метки нет',
        (await plusOf(HIST_A).count()) === 1 && (await markOf(HIST_A).count()) === 0,
      );
      check(
        'B подписан «разговоров ещё нет»',
        (await rowOf(REG_B).innerText()).includes('разговоров ещё нет'),
      );

      // ── «+» в строке добавляет проект в реестр ─────────────────────────────
      await plusOf(HIST_A).click();
      const aSaved = await settle(async () => (await names()).includes(HIST_A));
      check('«+» у A записал A в реестр панели', aSaved, JSON.stringify(await names()));
      check(
        'строка A получила метку',
        await settle(async () => (await markOf(HIST_A).count()) === 1),
      );
      check('«+» у A исчез', (await plusOf(HIST_A).count()) === 0);

      // ── «Открыть несколько» ─────────────────────────────────────────────────
      await page.getByRole('button', { name: 'Открыть несколько' }).click();
      const dialog = page.getByRole('dialog', { name: 'Открыть проекты' });
      await dialog.waitFor();
      await wait(600);
      await shot('02-dialog');
      const submit = dialog.getByRole('button', { name: /^Открыть \d+ проект/ });
      const submitOff = await dialog
        .getByRole('button', { name: /^Открыть 0 проект/ })
        .isDisabled();
      check('без отметок кнопка открытия выключена', submitOff);
      await dialog.getByRole('checkbox', { name: new RegExp(REG_B) }).check();
      await dialog.getByRole('checkbox', { name: new RegExp(HIST_C) }).check();
      check(
        'счётчик кнопки — «Открыть 2 проекта»',
        (await submit.innerText()).trim() === 'Открыть 2 проекта',
      );
      await submit.click();
      await dialog.waitFor({ state: 'hidden' });
      const tabs = workspace.getByRole('tab');
      const tabNames = await settle(async () => (await tabs.count()) === 3).then(() =>
        tabs.allInnerTexts(),
      );
      check(
        'открылись вкладки B и C',
        tabNames.some((t) => t.includes(REG_B)) && tabNames.some((t) => t.includes(HIST_C)),
        JSON.stringify(tabNames),
      );

      // ── Шапка вкладки C: добавить и перейти ──────────────────────────────────
      const tabC = page.getByRole('tab', { name: new RegExp(HIST_C) });
      await tabC.click();
      const projectBar = page.getByRole('group', { name: 'Проект', exact: true });
      const save = projectBar.getByRole('button', { name: 'В «Проекты»' });
      await save.waitFor({ timeout: 15_000 });
      await shot('03-header-save');
      await save.click();
      check(
        '«В «Проекты»» в шапке записал C в реестр',
        await settle(async () => (await names()).includes(HIST_C)),
        JSON.stringify(await names()),
      );
      const saved = projectBar.getByRole('button', { name: 'В «Проектах»' });
      check(
        'кнопка стала «В «Проектах»»',
        await saved.waitFor({ timeout: 10_000 }).then(
          () => true,
          () => false,
        ),
      );
      await shot('04-header-saved');
      const cId = (await registry()).find((item) => item.path.endsWith(HIST_C))?.id;
      const trail = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) trail.push(frame.url());
      });
      await saved.click();
      check(
        '«В «Проектах»» ведёт к настройкам проекта C',
        await settle(
          async () => page.url().includes('/projects') && page.url().includes(`id=${cId}`),
        ),
        `${page.url()} ← ${trail.join(' → ')}`,
      );

      // ── Закрытый B остаётся в списке, окно знает открытые вкладки ───────────
      await openChat();
      const tabB = page.getByRole('tab', { name: new RegExp(REG_B) });
      await tabB.waitFor({ timeout: 15_000 });
      await tabB.focus();
      await page.keyboard.press('Delete');
      check('вкладка B закрыта', await settle(async () => (await tabB.count()) === 0));
      await openHomeProjects();
      check(
        'закрытый B по-прежнему в списке, с меткой',
        await settle(async () => (await markOf(REG_B).count()) === 1),
      );
      await page.getByRole('button', { name: 'Открыть несколько' }).click();
      await dialog.waitFor();
      await wait(600);
      const boxC = dialog.getByRole('checkbox', { name: new RegExp(HIST_C) });
      const boxB = dialog.getByRole('checkbox', { name: new RegExp(REG_B) });
      check(
        'в окне открытый C отмечен и выключен, закрытый B доступен',
        (await boxC.isChecked()) &&
          (await boxC.isDisabled()) &&
          !(await boxB.isChecked()) &&
          (await boxB.isEnabled()),
      );
      const axeLight = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      check(
        'axe: окно без нарушений (светлая тема)',
        axeLight.violations.length === 0,
        axeLight.violations.map((v) => `${v.id}: ${v.nodes.length}`).join(', '),
      );
      await page.emulateMedia({ colorScheme: 'dark' });
      await wait(300);
      check(
        'тёмная тема включилась',
        (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
      );
      await shot('05-dialog-dark');
      const axeDark = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      check(
        'axe: окно без нарушений (тёмная тема)',
        axeDark.violations.length === 0,
        axeDark.violations.map((v) => `${v.id}: ${v.nodes.length}`).join(', '),
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      check(
        'Escape закрыл окно, фокус вернулся на «Открыть несколько»',
        await settle(() =>
          page.evaluate(() => document.activeElement?.textContent?.includes('Открыть несколько')),
        ),
      );

      // ── Ширина телефона ─────────────────────────────────────────────────────
      await page.setViewportSize({ width: 400, height: 800 });
      await page.emulateMedia({ colorScheme: 'light' });
      await openHomeProjects().catch(() => undefined);
      const opener = page.getByRole('button', { name: 'Открыть несколько' });
      if (await opener.isVisible().catch(() => false)) {
        await opener.click();
        await dialog.waitFor();
        await wait(600);
        await shot('06-dialog-narrow');
        const box = await dialog.boundingBox();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        check(
          'на 400px окно в пределах экрана, страница не едет вбок',
          box !== null && box.x >= 0 && box.x + box.width <= 400 && overflow <= 0,
          JSON.stringify({ box, overflow }),
        );
      } else {
        check(
          'на 400px список проектов чата доступен',
          false,
          'кнопка «Открыть несколько» не видна',
        );
      }

      check('страница без ошибок JS', errors.length === 0, errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
