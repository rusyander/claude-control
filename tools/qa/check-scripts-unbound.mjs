/**
 * Кейс config-resources-006: скрипт без привязки к событию помечен «Не
 * привязан», и счётчик «K без привязки к событиям» в шапке раздела «Скрипты»
 * равен числу карточек без метки «Используется». Число файлов в шапке
 * склоняется: «3 файла», а не «3 файлов» (так было до 27.09).
 *
 * Стенд одноразовый и засеян известным набором: три скрипта в `hooks/`, из них
 * ровно один вызывается хуком из settings.json. Так сверяются и счётчик с
 * метками (согласованность, о которой кейс), и оба — с правдой на диске: иначе
 * счётчик и метки, посчитанные из одного и того же неверного списка, сошлись бы.
 *
 * Запуск: `node tools/qa/check-scripts-unbound.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const BOUND = 'bound-probe.mjs';
const UNBOUND = ['lonely-one.mjs', 'lonely-two.mjs'];

/** Форма слова «файл» при числе — та, которую выбирает русский язык, а не одна на все числа. */
const FILE_FORMS = { one: 'файл', few: 'файла', many: 'файлов', other: 'файлов' };
const fileWord = (count) => FILE_FORMS[new Intl.PluralRules('ru').select(count)];

await runOnStand(
  {
    label: 'scripts-unbound',
    seed: ({ cfg }) => {
      const dir = join(cfg, 'hooks');
      mkdirSync(dir, { recursive: true });
      for (const name of [BOUND, ...UNBOUND]) {
        writeFileSync(join(dir, name), `// ${name}\nprocess.exit(0);\n`, 'utf8');
      }
      const command = `node "${join(dir, BOUND).replace(/\\/g, '/')}"`;
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }, null, 2)}\n`,
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/scripts`, { waitUntil: 'domcontentloaded' });
      const summary = page.getByText(/^\d+ файл(а|ов)? · /);
      await summary.waitFor({ timeout: 30_000 });
      await wait(500);
      const text = await summary.innerText();
      const match = /^(\d+) (файл|файла|файлов) · (\d+) без привязки к событиям/.exec(text);
      console.log(`  шапка: «${text}»`);
      check('в шапке «N файлов · K без привязки к событиям»', Boolean(match), text);
      const total = Number(match?.[1]);
      const unbound = Number(match?.[3]);
      check(
        `слово «файл» согласовано с числом: ${total} ${fileWord(total)}`,
        match?.[2] === fileWord(total),
        text,
      );

      const cards = page.locator('[data-agent-anchor]');
      const labels = await cards.evaluateAll((nodes) =>
        nodes.map((node) => ({ text: node.innerText })),
      );
      const withUsed = labels.filter(({ text }) => text.includes('Используется')).length;
      const withoutUsed = labels.length - withUsed;
      check('N = числу карточек', total === labels.length, `N ${total}, карточек ${labels.length}`);
      check(
        'K = числу карточек без метки «Используется»',
        unbound === withoutUsed,
        `K ${unbound}, без метки ${withoutUsed}`,
      );
      check('N и K сходятся с диском: 3 файла, 2 без хука', total === 3 && unbound === 2, text);
      for (const name of UNBOUND) {
        const card = labels.find(({ text }) => text.includes(name));
        check(
          `«${name}» без метки «Используется» и помечен «Не привязан»`,
          Boolean(card) && !card.text.includes('Используется') && card.text.includes('Не привязан'),
          card?.text.replace(/\s+/g, ' ') ?? 'карточки нет',
        );
      }
      const bound = labels.find(({ text }) => text.includes(BOUND));
      check(
        `«${BOUND}» (вызывается хуком Stop) помечен «Используется»`,
        Boolean(bound) && bound.text.includes('Используется'),
        bound?.text.replace(/\s+/g, ' ') ?? 'карточки нет',
      );
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
