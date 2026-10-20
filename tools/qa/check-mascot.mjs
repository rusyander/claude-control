/**
 * Маскот «Дека» в живой панели: боковая панель, сводка, реплики, выключение,
 * чат и страница 404.
 *
 * - Первое открытие браузера — приветствие; повторное — тишина.
 * - Разговор впервые стал ждущим → реплика «ждёт вашего ответа» с кнопкой
 *   «Открыть», которая ведёт в этот чат; настроение — `waiting`.
 * - Клик по Деке открывает сводку: ждущий разговор в списке; Escape закрывает
 *   и возвращает фокус на Деку. axe по открытой сводке — без нарушений.
 * - Пять быстрых кликов — `dizzy`.
 * - «Спрятать» убирает Деку, пустой чат его больше не показывает; тумблер в
 *   «Настройки → Общие» возвращает обоих.
 * - Неизвестный адрес — Дека «потерялся».
 *
 * Путь настоящий: одноразовая панель над временным домом, разговор засеян
 * транскриптом. Подменён ОДИН ответ — `GET /api/chat/awaiting` (вопросы
 * деревьев из памяти сервера): без живого агента иначе не сделать разговор
 * ждущим. Настройки маскота — localStorage браузера проверки.
 *
 * Запуск: `node tools/qa/check-mascot.mjs` (стенд поднимается сам);
 * `SHOTS=<папка>` — снимки.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CHAT = 'qa-mascot-chat';
const PREFS = 'agentdeck.mascot';

function seedTranscript(cfg, home) {
  const cwd = join(home, 'qa-mascot-project');
  mkdirSync(cwd, { recursive: true });
  const dir = join(cfg, 'projects', 'qa-mascot-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${CHAT}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      uuid: `${CHAT}-u1`,
      sessionId: CHAT,
      timestamp: new Date().toISOString(),
      cwd,
      message: { role: 'user', content: 'Проверь вход в систему' },
    })}\n`,
  );
}

await runOnStand(
  {
    label: 'mascot',
    settings: { theme: 'light' },
    seed: ({ home, cfg }) => seedTranscript(cfg, home),
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    let asking = false;
    await page.route('**/api/chat/awaiting', (route) =>
      route.fulfill({
        json: {
          chats: asking
            ? [{ chatId: CHAT, kind: 'question', askedAt: new Date().toISOString() }]
            : [],
        },
      }),
    );

    const companion = page.locator('[data-mascot-companion]');
    const trigger = page.locator('[data-mascot-trigger]');
    const mood = () => companion.getAttribute('data-mascot-mood');

    try {
      // ── Приветствие: один раз на браузер ───────────────────────────────────
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      await companion.waitFor({ timeout: 20_000 });
      check(
        'Дека стоит внизу боковой панели',
        (await page.locator('nav [data-mascot-companion]').count()) === 1,
      );
      const greet = page.locator('[data-mascot-speech="greet"]');
      check(
        'первое открытие — приветствие',
        await greet.waitFor({ timeout: 8_000 }).then(
          () => true,
          () => false,
        ),
      );
      const stored = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
        PREFS,
      );
      check('знакомство запомнено в браузере', stored.greeted === true, JSON.stringify(stored));
      await shot('01-greet');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await companion.waitFor();
      await wait(4_000);
      check('повторное открытие — без приветствия', (await greet.count()) === 0);

      // ── Покой: разовые действия с паузами, при «Меньше движения» — ни одного ──
      const watchActs = (ms) =>
        page.evaluate(
          (span) =>
            new Promise((resolve) => {
              const figure = document.querySelector('nav [data-mascot]');
              const seen = [];
              const observer = new MutationObserver(() => seen.push(figure.dataset.act ?? '-'));
              observer.observe(figure, { attributes: true, attributeFilter: ['data-act'] });
              setTimeout(() => {
                observer.disconnect();
                resolve(seen);
              }, span);
            }),
          ms,
        );
      const acts = await watchActs(9_000);
      const played = acts.filter((act) => act !== '-');
      check(
        'покой — Дека сам что-то делает (моргнул, оглянулся…) и снова замирает',
        played.length > 0 && acts.includes('-'),
        acts.join(','),
      );
      await page.evaluate(() => (document.documentElement.dataset.reduceMotion = 'true'));
      const reduced = await watchActs(9_000);
      check('«Меньше движения» — ни одного действия', reduced.length === 0, reduced.join(','));
      await page.evaluate(() => delete document.documentElement.dataset.reduceMotion);

      // ── Разговор стал ждущим → реплика с переходом ─────────────────────────
      asking = true;
      const ask = page.locator('[data-mascot-speech="ask"]');
      const asked = await ask.waitFor({ timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      check('ждущий разговор — реплика «ждёт вашего ответа»', asked);
      if (asked) check('в реплике — ждёт ответа', /ждёт вашего ответа/.test(await ask.innerText()));
      check('настроение — waiting', (await mood()) === 'waiting', String(await mood()));
      await shot('02-ask');

      // ── Кнопка реплики ведёт в ждущий чат (реплика живёт 9 с — сразу) ──────
      if (asked) {
        await ask.locator('[data-mascot-speech-open]').click();
        await page.waitForURL(/\/chat/, { timeout: 5_000 }).catch(() => undefined);
        check('«Открыть» ведёт в этот чат', page.url().includes(`id=${CHAT}`), page.url());
        await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
        await companion.waitFor();
        await wait(1_500);
      } else check('«Открыть» ведёт в этот чат', false, 'реплики не было');

      // ── Сводка: список, Escape и фокус ─────────────────────────────────────
      await trigger.click();
      const panel = page.locator('[data-mascot-panel]');
      check(
        'клик открывает сводку',
        await panel.waitFor({ timeout: 3_000 }).then(
          () => true,
          () => false,
        ),
      );
      check(
        'aria-expanded отражает сводку',
        (await trigger.getAttribute('aria-expanded')) === 'true',
      );
      const waitingItems = panel.locator('[data-mascot-list="waiting"] li');
      check(
        'ждущий разговор — в списке сводки',
        (await waitingItems.count()) === 1,
        String(await waitingItems.count()),
      );
      const axe = await new AxeBuilder({ page }).include('[data-mascot-companion]').analyze();
      check(
        'axe по открытой сводке — без нарушений',
        axe.violations.length === 0,
        axe.violations.map((item) => `${item.id}: ${item.nodes.length}`).join('; '),
      );
      await shot('03-panel');
      await page.keyboard.press('Escape');
      check(
        'Escape закрывает сводку',
        await panel.waitFor({ state: 'detached', timeout: 3_000 }).then(
          () => true,
          () => false,
        ),
      );
      check(
        'фокус вернулся на Деку',
        await page.evaluate(
          () => document.activeElement?.hasAttribute('data-mascot-trigger') ?? false,
        ),
      );

      asking = false;

      // ── Пять быстрых кликов — голова кружится ──────────────────────────────
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      await companion.waitFor();
      await wait(1_500);
      for (let i = 0; i < 5; i += 1) await trigger.click({ delay: 10 });
      check('пять быстрых кликов — dizzy', (await mood()) === 'dizzy', String(await mood()));
      await page.keyboard.press('Escape');

      // ── Спрятать → нет ни в панели, ни в пустом чате ───────────────────────
      await trigger.click();
      await page.locator('[data-mascot-hide]').click();
      check(
        '«Спрятать» убирает Деку',
        await companion.waitFor({ state: 'detached', timeout: 3_000 }).then(
          () => true,
          () => false,
        ),
      );
      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('nav');
      await wait(2_000);
      check(
        'выключенный — пустой чат без Деки',
        (await page.locator('[data-mascot-greeting]').count()) === 0,
      );

      // ── Настройки возвращают ───────────────────────────────────────────────
      await page.goto(`${stand.webUrl}/settings?tab=general`, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('switch', { name: 'Показывать Деку' });
      await toggle.waitFor({ timeout: 10_000 });
      check(
        'тумблер выключен после «Спрятать»',
        (await toggle.getAttribute('aria-checked')) === 'false',
      );
      await toggle.click();
      check(
        'тумблер возвращает Деку',
        await companion.waitFor({ timeout: 3_000 }).then(
          () => true,
          () => false,
        ),
      );
      await shot('04-settings');

      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('nav');
      await wait(2_000);
      // Окно поверх чата — не дело маскота, но клик через него не пройдёт:
      // назвать его и закрыть.
      const dialog = page.getByRole('dialog');
      if ((await dialog.count()) > 0) {
        console.log(`  · поверх чата окно: «${(await dialog.first().innerText()).split('\n')[0]}»`);
        await shot('05-chat-dialog');
        await page.keyboard.press('Escape');
        await dialog
          .first()
          .waitFor({ state: 'detached', timeout: 3_000 })
          .catch(() => undefined);
      }
      const greeting = page.locator('[data-mascot-greeting]');
      check(
        'пустой чат — Дека с советом',
        await greeting.waitFor({ timeout: 10_000 }).then(
          () => true,
          () => false,
        ),
      );
      if ((await greeting.count()) > 0) {
        const before = await greeting.locator('[data-mascot-tip]').getAttribute('data-mascot-tip');
        await greeting.locator('[data-mascot-next-tip]').click();
        const after = await greeting.locator('[data-mascot-tip]').getAttribute('data-mascot-tip');
        check(
          '«Ещё совет» меняет совет',
          Boolean(before) && before !== after,
          `${before} → ${after}`,
        );
      }
      await shot('05-chat');

      // ── 404 ────────────────────────────────────────────────────────────────
      await page.goto(`${stand.webUrl}/no-such-section`, { waitUntil: 'domcontentloaded' });
      check(
        'неизвестный адрес — Дека потерялся',
        await page
          .locator('[data-mascot-note="lost"]')
          .waitFor({ timeout: 10_000 })
          .then(
            () => true,
            () => false,
          ),
      );
      await shot('06-not-found');
    } finally {
      await browser.close();
    }
  },
);
