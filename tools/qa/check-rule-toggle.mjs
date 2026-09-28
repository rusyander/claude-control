/**
 * Кейс config-resources-007: выключение правила обратимо и без потерь — после
 * «выключить → включить» текст правила побайтно тот же, что до выключения.
 *
 * Путь настоящий: тумблер правила в разделе «Правила» одноразового стенда →
 * панель → CLAUDE.md временного каталога конфигурации. Пока правило выключено,
 * его в файле нет ВОВСЕ — ни заголовка, ни текста (F1, решение владельца 27.09:
 * Claude Code читает файл целиком, выключенный текст стоил бы токенов). Текст и
 * место хранит state.json панели; включение возвращает правило на прежнее место
 * (F2) — файл после «выкл → вкл» байт в байт исходный.
 *
 * Шаг кейса «спросить в новом чате» требует модели и здесь не исполняется —
 * это названо в отчёте прогона, а не выдано за проверенное.
 *
 * Запуск: `node tools/qa/check-rule-toggle.mjs` (стенд поднимается сам).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const TITLE = 'Язык ответа';
const BODY = 'Отвечай по-русски.\n\n- Код и идентификаторы — как есть.\n- Без эмодзи.';
const OTHER = '## ПРАВИЛО: Краткость\n\nОтвечай кратко.';
const SEED = `# Мои инструкции\n\nСвободный абзац.\n\n## ПРАВИЛО: ${TITLE}\n\n${BODY}\n\n${OTHER}\n`;

/** Текст правила под его заголовком — где бы он ни лежал (активный или служебный раздел). */
const ruleText = (text) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{2,3} (?:ПРАВИЛО: )?${TITLE}$`).test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
};

await runOnStand(
  {
    label: 'rule-toggle',
    seed: ({ cfg }) => writeFileSync(join(cfg, 'CLAUDE.md'), SEED, 'utf8'),
  },
  async (stand, check) => {
    const file = join(stand.cfg, 'CLAUDE.md');
    const read = () => readFileSync(file, 'utf8');
    const stateFile = join(stand.cfg, 'agentdeck', 'state.json');
    const stored = () =>
      existsSync(stateFile)
        ? (JSON.parse(readFileSync(stateFile, 'utf8')).disabledRules ?? [])
        : [];
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/rules`, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('switch', { name: TITLE, exact: true });
      await toggle.waitFor({ timeout: 30_000 });
      check('исходно правило включено', (await toggle.getAttribute('aria-checked')) === 'true');
      const before = ruleText(read());
      check('исходный текст правила найден в файле', before === BODY, JSON.stringify(before));

      // Выключить.
      await toggle.click();
      await wait(1200);
      const off = read();
      check('выключено: тумблер снят', (await toggle.getAttribute('aria-checked')) === 'false');
      const card = page.locator('[data-agent-anchor]').filter({ hasText: TITLE });
      check('выключено: карточка помечена «выключено»', /выключено/i.test(await card.innerText()));
      check(
        'выключено: заголовка «## ПРАВИЛО: Язык ответа» в CLAUDE.md нет',
        !off.includes(`## ПРАВИЛО: ${TITLE}`),
        off,
      );
      check(
        'выключено (F1): текста правила в CLAUDE.md нет вовсе',
        !off.includes(TITLE) && !off.includes('Без эмодзи') && !/Отключённые правила/.test(off),
        off,
      );
      const kept = stored().find((item) => item.title === TITLE);
      check(
        'выключено (F1): текст правила дословно в state.json панели',
        kept?.body === BODY,
        JSON.stringify(stored()),
      );
      check('выключено: соседнее правило не тронуто', off.includes(OTHER));

      // F5 — выключенное правило не пропало из списка.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toggle.waitFor({ timeout: 30_000 });
      check(
        'после F5 правило в списке и выключено',
        (await toggle.getAttribute('aria-checked')) === 'false',
      );

      // Включить.
      await toggle.click();
      await wait(1200);
      const on = read();
      check('включено: тумблер стоит', (await toggle.getAttribute('aria-checked')) === 'true');
      check(
        'включено: заголовок «## ПРАВИЛО: Язык ответа» вернулся',
        on.includes(`## ПРАВИЛО: ${TITLE}\n\n`),
      );
      check(
        'включено: текст правила побайтно тот же',
        ruleText(on) === before,
        JSON.stringify(ruleText(on)),
      );
      check(
        'включено: служебного раздела выключенных не осталось',
        !/Отключённые правила/.test(on),
        on,
      );
      // F2: правило стояло первым — первым и вернулось; файл тот же до байта.
      check('включено (F2): CLAUDE.md байт в байт как до выключения', on === SEED, on);
      check(
        'включено: в state.json текста правила больше нет',
        stored().length === 0,
        JSON.stringify(stored()),
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
