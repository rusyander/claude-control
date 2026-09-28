/**
 * Кейс config-resources-004: счётчики фильтров «Команд» верны и суммируются
 * во «Все», а число строк под каждым фильтром равно числу на кнопке.
 *
 * Одной согласованности кнопок между собой мало: счётчики и список считаются
 * из одного массива, и сойдутся даже тогда, когда панель не увидела половину
 * файлов. Поэтому стенд одноразовый и засеян ИЗВЕСТНЫМ набором — два скилла и
 * три файла команд, — и счётчик сверяется ещё и с тем, что лежит на диске.
 * Встроенные команды — каталог самого фронта (с диска их не прочитать), поэтому
 * с диском сверяются три остальных источника: их сумма = ответу `/api/commands`.
 *
 * Запуск: `node tools/qa/check-commands-counts.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SKILLS = ['alpha-skill', 'beta-skill'];
const COMMANDS = ['probe-one', 'probe-two', 'probe-three'];
const FILTERS = ['Все', 'Скиллы', 'Файлы команд', 'Плагины', 'Встроенные'];

await runOnStand(
  {
    label: 'commands-counts',
    seed: ({ cfg }) => {
      for (const name of SKILLS) {
        mkdirSync(join(cfg, 'skills', name), { recursive: true });
        writeFileSync(
          join(cfg, 'skills', name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Use when probing ${name}\n---\n\nТело.\n`,
          'utf8',
        );
      }
      mkdirSync(join(cfg, 'commands'), { recursive: true });
      for (const name of COMMANDS) {
        writeFileSync(
          join(cfg, 'commands', `${name}.md`),
          `---\ndescription: Команда ${name}\n---\n\nСделай ${name}.\n`,
          'utf8',
        );
      }
    },
  },
  async (stand, check) => {
    const api = await stand.api('/commands');
    const list = api.body?.commands ?? [];
    const bySource = (source) => list.filter((item) => item.source === source).length;

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1200 });
      await page.goto(`${stand.webUrl}/commands`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^Все · \d+$/ }).waitFor({ timeout: 30_000 });
      await wait(800);

      const counts = {};
      for (const label of FILTERS) {
        const button = page.getByRole('button', { name: new RegExp(`^${label} · \\d+$`) });
        counts[label] = Number((await button.innerText()).split('·')[1].trim());
      }
      console.log(`  кнопки: ${JSON.stringify(counts)}`);

      check(
        '«Скиллы» = двум засеянным скиллам',
        counts['Скиллы'] === SKILLS.length,
        `${counts['Скиллы']}`,
      );
      check(
        '«Файлы команд» = трём засеянным файлам',
        counts['Файлы команд'] === COMMANDS.length,
        `${counts['Файлы команд']}`,
      );
      check('«Плагины» = 0 (плагинов нет)', counts['Плагины'] === 0, `${counts['Плагины']}`);
      check(
        'скиллы + файлы + плагины = всем командам с диска в ответе панели; встроенных > 0',
        counts['Скиллы'] + counts['Файлы команд'] + counts['Плагины'] === list.length &&
          bySource('skill') === SKILLS.length &&
          counts['Встроенные'] > 0,
        `API: ${list.length} (скиллов ${bySource('skill')}), встроенных ${counts['Встроенные']}`,
      );
      check(
        'сумма четырёх фильтров = «Все»',
        counts['Скиллы'] + counts['Файлы команд'] + counts['Плагины'] + counts['Встроенные'] ===
          counts['Все'],
        JSON.stringify(counts),
      );

      for (const label of FILTERS) {
        await page.getByRole('button', { name: new RegExp(`^${label} · \\d+$`) }).click();
        await wait(300);
        const rows = await page.locator('[data-command]').count();
        check(
          `«${label}»: строк столько же, сколько на кнопке`,
          rows === counts[label],
          `строк ${rows}, на кнопке ${counts[label]}`,
        );
      }
      await page.getByRole('button', { name: /^Скиллы · \d+$/ }).click();
      const shownSkills = await page
        .locator('[data-command]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-command')).sort());
      check(
        '«Скиллы»: это именно засеянные скиллы со слэшем',
        JSON.stringify(shownSkills) === JSON.stringify(SKILLS.map((name) => `/${name}`).sort()),
        JSON.stringify(shownSkills),
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
