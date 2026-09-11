/**
 * Сценарий `basics`: путь одного разговора от пустого чата до конца прогона.
 *
 * Снимается ровно то, что человек делает сам: открыл проект, написал вопрос с
 * вложением, увидел ответ по мере генерации, решил про права, ответил на
 * вопрос агента, заглянул в git и в код. Каждый кадр — состояние, а не
 * «страница целиком»: кусок с решением читается, а полный экран показывает
 * боковой список и шапку по шестому разу.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chat,
  frame,
  sse,
  settings,
  projectShell,
  openProject,
  openChat,
  closeOverlay,
} from './chat-stubs.mjs';

const WORK = 'help-chat-work';
const PERM = 'help-chat-perm';
const ASK = 'help-chat-ask';
const HANDOFF = 'help-chat-handoff';

/** Вопрос агента: три вопроса в одном вызове — так их и задаёт CLI. */
const QUESTIONS = {
  questions: [
    {
      question: 'Что считать датой заказа в выгрузке?',
      header: 'Дата',
      multiSelect: false,
      options: [
        { label: 'Дата создания', description: 'Когда заказ появился в базе.' },
        { label: 'Дата оплаты', description: 'Когда деньги подтвердил банк.' },
      ],
    },
    {
      question: 'Какой разделитель в CSV?',
      header: 'Разделитель',
      multiSelect: false,
      options: [
        { label: 'Точка с запятой', description: 'Открывается в Excel без плясок.' },
        { label: 'Запятая', description: 'Стандарт RFC 4180.' },
      ],
    },
    {
      question: 'Что входит в первую выгрузку?',
      header: 'Состав',
      multiSelect: true,
      options: [
        { label: 'Заказы', description: 'Шапка заказа.' },
        { label: 'Позиции', description: 'Строки заказа.' },
        { label: 'Возвраты', description: 'Отдельной таблицей.' },
      ],
    },
  ],
};

/** Блок предложения продолжить работу в чистой сессии — как его пишет агент. */
const HANDOFF_BLOCK = {
  done: 'Закрыт экспорт заказов: маршрут, тесты и справка.',
  next: 'Взяться за импорт: разобрать формат CSV и написать разбор.',
  checkpoint: '.agent/PROGRESS.md',
  pruned: 'Из TASKS.md убраны три сделанных пункта, уехали в .agent/ARCHIVE.md.',
};

const block = (kind, json) => ['```agentdeck:' + kind, JSON.stringify(json), '```'].join('\n');

const CHATS = [
  chat(WORK, 'Экспорт заказов в CSV', { preview: 'Добавь выгрузку' }),
  chat(PERM, 'Сборка релиза', { preview: 'Агент просит разрешение' }),
  chat(ASK, 'Формат выгрузки', { preview: 'Нужен ваш выбор' }),
  chat(HANDOFF, 'Импорт прайса', { preview: 'Этап закрыт' }),
];

const HISTORY = {
  [WORK]: {
    messages: [
      {
        id: 'w1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Посмотри, как устроена страница заказов.' }],
        timestamp: '2026-09-10T11:00:00.000Z',
      },
      {
        id: 'w2',
        role: 'assistant',
        blocks: [
          {
            type: 'tool',
            name: 'Read',
            input: JSON.stringify({ file_path: 'src/pages/Orders/OrdersPage.tsx' }),
          },
          {
            type: 'text',
            text: 'Страница собирает список из useOrders и рисует таблицу. Выгрузки нет ни в одном месте.',
          },
        ],
        timestamp: '2026-09-10T11:01:00.000Z',
        gitBranch: 'feature/orders-export',
        usage: {
          input: 1420,
          output: 310,
          cacheRead: 41200,
          cacheCreation: 2100,
          model: 'claude-opus-5',
          costUsd: 0.042,
        },
      },
    ],
    total: 2,
    hasMore: false,
  },
  [PERM]: { messages: [], total: 0, hasMore: false },
  [ASK]: { messages: [], total: 0, hasMore: false },
  [HANDOFF]: {
    messages: [
      {
        id: 'h1',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `Экспорт закрыт, проверки зелёные.\n\n${block('handoff', HANDOFF_BLOCK)}\n\nЖду решения.`,
          },
        ],
        timestamp: '2026-09-10T12:00:00.000Z',
      },
    ],
    total: 1,
    hasMore: false,
  },
};

/** Живой ответ: размышление, два вызова, расход по шагу и текст ответа. */
const ANSWER =
  frame({ kind: 'session', sessionId: WORK, startedAt: Date.now() }, 1) +
  frame(
    {
      kind: 'thinking',
      text: 'Выгрузка нужна там же, где список. Посмотрю, есть ли готовый клиент HTTP.',
    },
    2,
  ) +
  frame(
    {
      kind: 'usage',
      input: 980,
      output: 120,
      cacheRead: 52300,
      cacheCreation: 1800,
      model: 'claude-opus-5',
      costUsd: 0.031,
      toolIds: ['t1'],
    },
    3,
  ) +
  frame(
    {
      kind: 'tool',
      name: 'Grep',
      input: { pattern: 'export', path: 'src/pages/Orders' },
      id: 't1',
    },
    4,
  ) +
  frame(
    {
      kind: 'usage',
      input: 640,
      output: 410,
      cacheRead: 54100,
      cacheCreation: 900,
      model: 'claude-opus-5',
      costUsd: 0.028,
      toolIds: ['t2'],
    },
    5,
  ) +
  frame(
    { kind: 'tool', name: 'Write', input: { file_path: 'src/pages/Orders/export.ts' }, id: 't2' },
    6,
  ) +
  frame(
    {
      kind: 'text',
      text: 'Завёл src/pages/Orders/export.ts: собирает строки из тех же данных, что и таблица, и отдаёт их одним файлом. ',
    },
    7,
  ) +
  frame({ kind: 'text', text: 'Кнопку повесил в шапку страницы, рядом с фильтром.' }, 8);

/** Запрос прав: агент СТОИТ на вызове и ждёт решения человека. */
const PERMISSION = frame(
  {
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'rm -rf dist', description: 'Убрать прошлую сборку перед новой' },
    toolUseId: 'perm-1',
  },
  1,
);

const QUESTION = frame({ kind: 'tool', name: 'AskUserQuestion', input: QUESTIONS, id: 'ask-1' }, 1);

export async function shootBasics(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const attachment = join(home, 'orders-export.md');
  writeFileSync(attachment, '# Формат выгрузки\n\nНомер, дата, сумма, статус.\n', 'utf8');

  try {
    await settings(page);
    await projectShell(page);

    await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
    for (const [id, body] of Object.entries(HISTORY)) {
      await page.route(`**/api/chats/${id}/messages*`, (route) => route.fulfill({ json: body }));
    }
    // Два прогона уже идут на сервере: их подхватывает страница, и ровно они
    // дают пульту агентов счётчик, а вкладке — цветные точки.
    await page.route('**/api/chat/active', (route) =>
      route.fulfill({
        json: [
          { chatId: PERM, seq: 0 },
          { chatId: ASK, seq: 0 },
        ],
      }),
    );

    // Поток каждого прогона отдаётся ОДИН раз, дальше запрос висит: тело
    // фиксированной длины кончилось бы сразу, страница переподключилась бы
    // несколько раз и сдалась, а с ней ушли бы и карточка, и жёлтая точка.
    const once = (id, body) => {
      let hits = 0;
      return page.route(`**/api/chat/${id}/stream*`, (route) => {
        hits += 1;
        if (hits > 1) return;
        return route.fulfill(sse(body));
      });
    };
    await once(PERM, PERMISSION);
    await once(ASK, QUESTION);
    await once(WORK, '');

    await page.route('**/api/chat/send', (route) => route.fulfill(sse(ANSWER)));
    await page.route('**/api/chat/*/permission-decision', (route) =>
      route.fulfill({ json: { ok: true } }),
    );

    await openProject(page, web);

    // ── 01. Пустой чат проекта ───────────────────────────────────────────────
    await page
      .getByRole('button', { name: /Новый чат/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '01-project-empty');

    // ── 02. Вопрос и вложение в поле ввода ───────────────────────────────────
    await openChat(page, 'Экспорт заказов в CSV');
    const input = page.locator('textarea[data-chat-input]');
    await input.fill(
      'Добавь на страницу заказов выгрузку в CSV: колонки как в таблице, ' +
        'кнопка рядом с фильтром. Формат — во вложении.',
    );
    await page.locator('input[type="file"]').first().setInputFiles(attachment);
    await page.waitForTimeout(800);
    await scenario.shot(page, '02-composer', { clip: '[class*="_composer"]' });

    // ── 03. Ответ по мере генерации ──────────────────────────────────────────
    await input.press('Enter');
    await page.waitForTimeout(4000);
    await scenario.shot(page, '03-answer');

    // ── 04. Запрос прав ──────────────────────────────────────────────────────
    await openChat(page, 'Сборка релиза');
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-permission');

    // ── 05. Вопрос агента ────────────────────────────────────────────────────
    // Карточка трёх вопросов выше рабочего окна, а лента сама уезжает вниз:
    // на 900 px в кадр попадала бы её середина без первого вопроса.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await openChat(page, 'Формат выгрузки');
    await page.waitForTimeout(2500);
    await page
      .locator('[class*="_question_"]')
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    // Поле шире обычного: карточка узкая, а в документе кадр растягивается на
    // всю ширину колонки — без запаса вокруг её буквы раздувает вдвое.
    await scenario.shot(page, '05-question', { clip: '[class*="_question_"]', padding: 160 });
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── 06. Пульт git над лентой ─────────────────────────────────────────────
    // Окно выше рабочего: сам пульт длиннее 900 px, а область кадра в наборе
    // обрезается по окну — на прежней высоте он уезжал за нижний край.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await page
      .getByRole('button', { name: new RegExp('feature/orders-export') })
      .first()
      .click();
    await page.waitForTimeout(1200);
    // Пульты узкие (350–400 px), и поле вокруг них не украшение: кадр в справке
    // раздаётся на ширину колонки, а узкая картинка в ней разбухает до плаката.
    await scenario.shot(page, '06-branch', { clip: '[role="dialog"]', padding: 240 });
    // Escape пульт не закрывает, а его подложка перехватывает клики: закрываем
    // именно подложкой, иначе следующий шаг стоит до таймаута.
    await closeOverlay(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── 07. Меню чата: тумблеры прав и правила ───────────────────────────────
    await page.setViewportSize({ width: 1440, height: 1240 });
    const menu = page.locator('[role="dialog"]').first();
    await page.getByRole('button', { name: 'Настройки чата' }).first().click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '07-menu', { clip: '[role="dialog"]', padding: 220 });

    // ── 08. Низ того же меню: действия над разговором ────────────────────────
    // Меню прокручивается внутри себя (max-height), поэтому «Перезапустить
    // сессию» человек видит только опустив список — и кадр обязан это повторить.
    await menu.evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await page.waitForTimeout(800);
    await scenario.shot(page, '08-menu-actions', { clip: '[role="dialog"]', padding: 220 });
    await closeOverlay(page);

    // ── 09. Пульт агентов ────────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /Агенты/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '09-agents', { clip: '[role="dialog"]', padding: 220 });
    await closeOverlay(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── 10. Продолжение в чистой сессии ──────────────────────────────────────
    await openChat(page, 'Импорт прайса');
    await page.waitForTimeout(2000);
    await scenario.shot(page, '10-handoff');
  } finally {
    await page.close();
  }
}
