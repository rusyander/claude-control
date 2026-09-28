/**
 * Кейс chat-006: поиск разговоров — «По названию» сужает список по названию,
 * «По сообщениям» находит разговор, где слово есть только в тексте переписки,
 * пустой запрос возвращает весь список; счётчик «Показано N из M» следует.
 *
 * Разговоры — настоящие транскрипты CLI, засеянные во временный каталог
 * `projects/`: три сессии, у двух в названии «Починить». Слово «кактус» стоит
 * только в середине переписки первой — ни в названии, ни в последней реплике
 * (её список показывает превью). Так «ищут своё» проверяется в обе стороны:
 * по названию «кактус» не находится, по сообщениям — находится.
 *
 * Модель не нужна: список и поиск работают по файлам. Окно «нужен доступ»
 * (у стенда нет входа в CLI) закрывается его же кнопкой. Список разговоров
 * показывает чаты ОТКРЫТОГО проекта (домашняя вкладка — только песочница),
 * поэтому проект заводится в реестр и открывается, как это делает человек:
 * «Проекты» в боковой панели → строка проекта.
 *
 * Запуск: `node tools/qa/check-chat-search.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const PROJECT = 'search-proj';

const CHATS = [
  [
    '11111111-1111-4111-8111-111111111111',
    'Починить сборку фронта',
    ['Готово, заодно полил кактус на подоконнике.', 'Пожалуйста.'],
  ],
  ['22222222-2222-4222-8222-222222222222', 'Обзор миграций базы', ['Миграции в порядке.']],
  ['33333333-3333-4333-8333-333333333333', 'Починить тесты сервера', ['Тесты зелёные.']],
];

/** Транскрипт: вопрос, ответ, и на каждый следующий ответ — короткая реплика человека. */
const transcript = (sid, cwd, title, replies, now) => {
  const lines = [];
  let minute = 0;
  const at = () => new Date(now - 3600e3 + (minute += 1) * 60e3).toISOString();
  lines.push({
    type: 'user',
    timestamp: at(),
    sessionId: sid,
    cwd,
    uuid: `u0-${sid}`,
    message: { role: 'user', content: title },
  });
  replies.forEach((text, index) => {
    if (index > 0) {
      lines.push({
        type: 'user',
        timestamp: at(),
        sessionId: sid,
        cwd,
        uuid: `u${index}-${sid}`,
        message: { role: 'user', content: 'спасибо' },
      });
    }
    lines.push({
      type: 'assistant',
      timestamp: at(),
      sessionId: sid,
      cwd,
      uuid: `a${index}-${sid}`,
      message: {
        id: `m${index}-${sid}`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
};

await runOnStand(
  {
    label: 'chat-search',
    seed: ({ cfg, home }) => {
      const project = join(home, PROJECT);
      mkdirSync(project, { recursive: true });
      // Имя папки проекта — как у CLI: каждый символ пути, кроме букв и цифр, — дефис.
      const dir = join(cfg, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (const [sid, title, replies] of CHATS) {
        writeFileSync(
          join(dir, `${sid}.jsonl`),
          transcript(sid, project, title, replies, now),
          'utf8',
        );
      }
    },
  },
  async (stand, check) => {
    const project = join(stand.home, PROJECT);
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check('проект заведён в реестр стенда', added.status === 200, added.text.slice(0, 200));
    const listed = await stand.api('/chats');
    check(
      'панель видит три засеянных разговора',
      Array.isArray(listed.body) && listed.body.length === 3,
      listed.text.slice(0, 300),
    );
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      // Пока открыто окно «нужен доступ», остальная страница скрыта от дерева
      // доступности — ждём разметку, а не роль. Холодный Vite собирает чат
      // долго, отсюда запас по времени.
      await page
        .locator('[role="tablist"][aria-label="Режим поиска"]')
        .waitFor({ timeout: 90_000 });
      await wait(1500);
      const blocking = page.getByRole('dialog');
      if ((await blocking.count()) > 0) {
        await blocking.first().getByRole('button', { name: 'Закрыть' }).first().click();
        await blocking
          .first()
          .waitFor({ state: 'hidden', timeout: 5000 })
          .catch(() => undefined);
      }
      await page.getByRole('tab', { name: 'Проекты', exact: true }).click();
      await page.locator('button').filter({ hasText: PROJECT }).first().click();
      await page.getByText(/^Показано \d+ из \d+$/).waitFor({ timeout: 30_000 });
      await wait(1000);
      // Счётчика может не быть вовсе (в режиме «По сообщениям» при коротком
      // запросе вместо него подсказка) — это результат, а не сбой сценария.
      const counter = async () => {
        const label = page.getByText(/^Показано \d+ из \d+$/);
        if ((await label.count()) === 0) return { found: null, total: null };
        const [, found, total] = /Показано (\d+) из (\d+)/
          .exec(await label.innerText())
          .map(Number);
        return { found, total };
      };
      const search = page
        .getByRole('searchbox', { name: 'Поиск по чатам' })
        .or(page.getByLabel('Поиск по чатам'))
        .first();
      const listText = () =>
        page
          .getByRole('tablist', { name: 'Режим поиска' })
          .locator('xpath=ancestor::*[3]')
          .innerText();
      const settle = async () => wait(900);

      const start = await counter();
      check(
        'исходно показаны все: 3 из 3',
        start.found === 3 && start.total === 3,
        JSON.stringify(start),
      );

      // По названию.
      await page.getByRole('tab', { name: 'По названию' }).click();
      await search.fill('Починить');
      await settle();
      const byTitle = await counter();
      const titleList = await listText();
      check(
        '«По названию» «Починить»: 2 из 3',
        byTitle.found === 2 && byTitle.total === 3,
        JSON.stringify(byTitle),
      );
      check(
        '«По названию»: остались именно совпадения',
        titleList.includes('Починить сборку фронта') &&
          titleList.includes('Починить тесты сервера') &&
          !titleList.includes('Обзор миграций базы'),
        titleList.slice(0, 400),
      );
      await search.fill('кактус');
      await settle();
      check(
        '«По названию» «кактус»: 0 — слова нет ни в одном названии',
        (await counter()).found === 0,
        JSON.stringify(await counter()),
      );

      // По сообщениям.
      await page.getByRole('tab', { name: 'По сообщениям' }).click();
      await settle();
      await wait(1500);
      const byText = await counter();
      const textList = await listText();
      check(
        '«По сообщениям» «кактус»: 1 из 3',
        byText.found === 1 && byText.total === 3,
        JSON.stringify(byText),
      );
      check(
        '«По сообщениям»: найден разговор, где слово только в тексте',
        textList.includes('Починить сборку фронта'),
        textList.slice(0, 400),
      );

      // Очистить — в том режиме, где человек сейчас стоит («По сообщениям»):
      // кейс не просит переключаться обратно.
      await search.fill('');
      // С запасом сверх дебаунса: остаток прошлого поиска не должен сойти за ответ.
      await wait(3000);
      const cleared = await counter();
      const clearedList = await listText();
      check(
        'пустой запрос: снова 3 из 3',
        cleared.found === 3 && cleared.total === 3,
        `${JSON.stringify(cleared)} — ${clearedList.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
      check(
        'пустой запрос: в списке снова все три разговора',
        CHATS.every(([, title]) => clearedList.includes(title)),
        clearedList.replace(/\s+/g, ' ').slice(0, 300),
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
