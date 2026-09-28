/**
 * Кейс settings-models-004: расход показывается в токенах, а не в долларах, —
 * в «Настройки → Расходы» токены стоят единицей по умолчанию, «Аналитика» за
 * 7 дней считает токены и сессии по транскриптам, и каждая сумма в $ помечена
 * как оценка (или её нет).
 *
 * Транскрипты засеяны: две сессии по три ответа модели с известным расходом
 * (вход 1000, вывод 500, чтение кэша 20000) — итог 129 000 токенов и 2 сессии
 * известен заранее, так что «считает по транскриптам» сверяется числом, а не
 * тем, что на экране вообще есть цифры. Долларовые суммы ищутся по всему
 * тексту страницы, на каждой вкладке аналитики; рядом с суммой (в её карточке)
 * обязана стоять пометка оценки.
 *
 * Запуск: `node tools/qa/check-spend-units.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SESSIONS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const MARK = /оценк|эквивалент|если бы платили|тариф|за миллион/i;

const transcript = (sid, now) => {
  const at = (hours) => new Date(now - hours * 3600e3).toISOString();
  const answer = (index) => ({
    type: 'assistant',
    timestamp: at(index),
    sessionId: sid,
    cwd: 'C:\\probe',
    requestId: `r-${sid}-${index}`,
    uuid: `a-${sid}-${index}`,
    message: {
      id: `m-${sid}-${index}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const question = {
    type: 'user',
    timestamp: at(5),
    sessionId: sid,
    cwd: 'C:\\probe',
    uuid: `q-${sid}`,
    message: { role: 'user', content: 'привет' },
  };
  return `${[question, answer(1), answer(2), answer(3)].map((line) => JSON.stringify(line)).join('\n')}\n`;
};

/** Все долларовые суммы на странице с текстом их карточки (до 5 уровней вверх). */
const dollarsWithContext = (page) =>
  page.locator('main').evaluate((main) => {
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/\$/.test(node.textContent)) continue;
      let box = node.parentElement;
      for (let level = 0; level < 5 && box?.parentElement && box.parentElement !== main; level += 1)
        box = box.parentElement;
      found.push({
        text: node.textContent.trim(),
        context: (box?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400),
      });
    }
    return found;
  });

await runOnStand(
  {
    label: 'spend-units',
    seed: ({ cfg }) => {
      const dir = join(cfg, 'projects', 'C--probe');
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (const sid of SESSIONS)
        writeFileSync(join(dir, `${sid}.jsonl`), transcript(sid, now), 'utf8');
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1400 });

      // «Настройки → Расходы»: единица по умолчанию — токены.
      await page.goto(`${stand.webUrl}/settings?tab=spend`, { waitUntil: 'domcontentloaded' });
      const money = page.getByRole('switch', { name: /Показывать в деньгах/ });
      await money.waitFor({ timeout: 30_000 });
      const spendText = await page.locator('main').innerText();
      check(
        '«Расходы»: сказано, что расход показывается в токенах',
        /расход показывается в токенах/i.test(spendText),
        spendText.slice(0, 400),
      );
      check(
        '«Расходы»: «Показывать в деньгах» по умолчанию выключено',
        (await money.getAttribute('aria-checked')) === 'false',
      );
      const spendDollars = await dollarsWithContext(page);
      const bareSpend = spendDollars.filter(({ context }) => !MARK.test(context));
      check(
        '«Расходы»: каждая сумма в $ — тариф для оценки',
        bareSpend.length === 0,
        bareSpend
          .slice(0, 3)
          .map((d) => `${d.text} ← ${d.context}`)
          .join('\n'),
      );

      // «Аналитика», 7 дней.
      await page.goto(`${stand.webUrl}/analytics`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '7 дней', exact: true }).click();
      await page.getByText('Всего токенов').waitFor({ timeout: 30_000 });
      await wait(1000);
      const summary = await page.locator('main').innerText();
      check(
        '«Аналитика»: всего токенов 129 000 — ровно засеянное',
        /129[\s\u00a0\u202f]?000/.test(summary),
        summary.slice(0, 500),
      );
      check(
        '«Аналитика»: 2 сессии',
        /2 активные сессии/.test(summary) || /Сессии\s*2/.test(summary),
        summary.slice(0, 500),
      );

      const tabs = [
        'Сводка',
        'Модели и проекты',
        'Инструменты и часы',
        'Сессии',
        'Агенты и контур',
      ];
      let dollars = 0;
      for (const name of tabs) {
        const tab = page
          .getByRole('tab', { name: new RegExp(`^${name}`) })
          .or(page.getByRole('button', { name: new RegExp(`^${name}`) }))
          .first();
        if ((await tab.count()) === 0) {
          check(`«Аналитика»: вкладка «${name}» найдена`, false);
          continue;
        }
        await tab.click();
        await wait(1200);
        const found = await dollarsWithContext(page);
        dollars += found.length;
        const bare = found.filter(({ context }) => !MARK.test(context));
        check(
          `«Аналитика → ${name}»: $ без пометки «оценка» нет`,
          bare.length === 0,
          bare
            .slice(0, 3)
            .map((d) => `${d.text} ← ${d.context}`)
            .join('\n'),
        );
      }
      console.log(`  долларовых сумм в аналитике: ${dollars}`);
      check(
        'страница без необработанных ошибок',
        page.errors.length === 0,
        page.errors.join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
