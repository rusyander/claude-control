/**
 * Кейс groups-014: шаги скилла со «странными» заголовками — один разбор
 * (`@agentdeck/contracts/skill-steps`) на сервер и страницу, от файла до чата.
 *
 * Скилл на диске одноразовой панели записан с концами строк CRLF и с
 * заголовками, на которых спотыкались прежние копии разбора: обратные кавычки в
 * названии, `Step 2)`, `шаг 3 —`, заголовок-«шаг» внутри блока кода и
 * четырёхзначный «номер» раздела.
 *
 * Что доказывается (всё через настоящий маршрут и настоящий экран):
 *   1. `GET /groups/:id/path` — ровно три шага скилла, названия без хвостов CR;
 *   2. окно группы, «Порядок работы» — те же три строки, заголовка из блока
 *      кода и «## 2024. Итоги» нет;
 *   3. окно шага «Fix it» показывает текст ИМЕННО этого шага (CRLF не рвёт
 *      раздел, соседний шаг не прилипает);
 *   4. чат: группа выбрана в меню «Настройки чата», сообщение отправлено из
 *      поля — фальшивый `claude` получил строку шага внутри скилла с его местом
 *      «right after its step "Fix it"».
 *
 * Запуск: `node tools/qa/check-group-odd-headings.mjs` (стенд поднимается сам).
 * `SHOTS=<каталог>` — снимки окна группы и шага.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chatGroupMenu, openProjectChat, sendAndWait } from './chat-walk.mjs';
import { FAKE_APPEND_CLI } from './fake-cli-append.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
const SKILL_ID = 'odd-steps';
const GROUP = 'Odd headings';
const STEPS = ['`Read` the diff', 'Fix it', 'Ship'];
const SKILL = [
  '---',
  `name: ${SKILL_ID}`,
  'description: A skill whose step headings are written oddly.',
  '---',
  '',
  '# Odd steps',
  '',
  'Intro text.',
  '',
  '## 1. `Read` the diff',
  'READ_BODY read everything.',
  '',
  '```markdown',
  '## 9. Fenced example that is not a step',
  '```',
  '',
  '### Step 2) Fix it',
  'FIX_BODY fix what was found.',
  '',
  '#### шаг 3 — Ship',
  'SHIP_BODY ship it.',
  '',
  '## 2024. Итоги',
  'Not a step either.',
  '',
].join('\r\n');

const NOW = '2026-09-28T00:00:00.000Z';

await runOnStand(
  {
    label: 'odd-headings',
    fakeCli: { claude: FAKE_APPEND_CLI },
    seed: ({ home, cfg }) => {
      mkdirSync(join(cfg, 'skills', SKILL_ID), { recursive: true });
      writeFileSync(join(cfg, 'skills', SKILL_ID, 'SKILL.md'), SKILL, 'utf8');
      mkdirSync(join(home, 'proj'), { recursive: true });
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    await stand.api('/projects', { method: 'POST', body: { path: project } });
    const created = await stand.api('/groups', {
      method: 'POST',
      body: { name: GROUP, members: [{ kind: 'skill', id: SKILL_ID }] },
    });
    check(
      'группа создана',
      created.status === 200,
      `${created.status} ${created.text.slice(0, 200)}`,
    );
    const id = created.body?.id;

    // 1. Маршрут пути.
    const path = await stand.api(`/groups/${id}/path`);
    const titles = (path.body?.entries ?? [])
      .filter((entry) => entry.kind === 'skill-step')
      .map((entry) => entry.title);
    check(
      'API: три шага скилла, названия без хвостов',
      JSON.stringify(titles) === JSON.stringify(STEPS),
      JSON.stringify(titles),
    );

    // Шаг человека внутри скилла — после шага «Fix it», как его ставит «+» окна.
    const saved = await stand.api(`/groups/${id}/path/steps`, {
      method: 'PUT',
      body: {
        steps: [
          {
            id: 'inside',
            anchor: 'work',
            order: 0,
            kind: 'prompt',
            title: { ru: 'Проверка', en: 'Check' },
            prompt: { ru: 'Сверь', en: 'MARK_ODD_INSIDE compare the screen.' },
            source: 'ru',
            createdAt: NOW,
            within: { skillId: SKILL_ID, index: 1, after: 'Fix it' },
          },
        ],
      },
    });
    check(
      'шаг внутри скилла сохранён',
      saved.status === 200,
      `${saved.status} ${saved.text.slice(0, 200)}`,
    );

    const browser = await chromium.launch();
    try {
      // 2–3. Окно группы и окно шага.
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      const tile = page
        .getByRole('heading', { name: GROUP, exact: true })
        .getByRole('button', { name: GROUP, exact: true });
      await tile.waitFor({ timeout: 90_000 });
      await tile.click();
      const dialog = page.getByRole('dialog', { name: GROUP, exact: true });
      await dialog.waitFor({ timeout: 10_000 });
      const list = dialog.getByRole('list', { name: 'Шаги порядка работы' });
      await list.waitFor({ timeout: 15_000 });
      await wait(800);
      const text = (await list.innerText()).replace(/\s+/g, ' ');
      // Английский скилл в русском интерфейсе: строка — номер шага словами
      // интерфейса, пока модель не описала шаг; оригинал названия — в окне шага.
      check(
        'окно группы: ровно три шага скилла (Шаг 1–3), четвёртого нет',
        [1, 2, 3].every((n) => text.includes(`Шаг ${n} скилла`)) && !text.includes('Шаг 4 скилла'),
        text.slice(0, 400),
      );
      check(
        'окно группы: заголовок из блока кода и «2024. Итоги» — не шаги',
        !text.includes('Fenced example') && !text.includes('Итоги'),
        text.slice(0, 400),
      );
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await dialog.screenshot({ path: join(SHOTS, 'odd-headings-path.png') });
      }
      await list
        .getByRole('button', { name: /^Шаг 2 скилла/ })
        .first()
        .click();
      const step = page.getByRole('dialog').filter({ hasText: 'FIX_BODY' }).last();
      await step.waitFor({ timeout: 8000 });
      await wait(800);
      const body = (await step.innerText()).replace(/\s+/g, ' ');
      check(
        'окно шага 2: текст своего шага, без соседей',
        body.includes('FIX_BODY') && !body.includes('SHIP_BODY') && !body.includes('READ_BODY'),
        body.slice(0, 400),
      );
      if (SHOTS) await step.screenshot({ path: join(SHOTS, 'odd-headings-step.png') });
      check('страница групп без ошибок', page.errors.length === 0, page.errors.join(' | '));
      await page.close();

      // 4. Чат: первый ход (меню группы есть только у существующего разговора),
      // выбор группы в меню, второй ход из поля.
      const chat = await openProjectChat(stand, browser, project, 'proj');
      check('первый ход дошёл до CLI', Boolean(await sendAndWait(chat, stand, 'warm up turn')));
      await chatGroupMenu(chat, GROUP);
      const turn = await sendAndWait(chat, stand, 'odd headings turn');
      const append = turn?.append ?? '';
      check('CLI получил ход чата с группой', Boolean(turn));
      check(
        'чат: шаг внутри скилла доехал с местом «right after its step "Fix it"»',
        append.includes('MARK_ODD_INSIDE') &&
          append.includes(`Skill \`${SKILL_ID}\`, right after its step "Fix it"`),
        append.slice(0, 600),
      );
      check('чат без ошибок страницы', chat.errors.length === 0, chat.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
