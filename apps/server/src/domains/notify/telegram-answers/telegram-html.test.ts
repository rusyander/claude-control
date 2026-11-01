import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInbox, InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { composeRich, composeSignal } from '../telegram-text.ts';
import { deliverTelegram } from '../telegram-delivery.ts';
import { editMessageText, sendMessage } from './bot-api.ts';
import { collectPendingAsks } from './collect.ts';
import { DIVIDER, keyboardOf, messageText, MESSAGE_LIMIT, OUTCOME, sentItemOf } from './compose.ts';
import { escapeHtml, htmlToPlain } from './html.ts';
import type { PendingAskItem, SentItem, SentMessage } from './telegram-answers.types.ts';

/**
 * Золотая таблица сообщений Telegram в разметке HTML (итоговый формат владельца
 * 25.10.2026 после живой проверки): первая строка — «вид · 📁 проект · сессия»
 * жирным, вторая — суть ровно один раз, список вариантов — только с описаниями,
 * подробности в цитате, ссылка «Открыть чат →» на 127.0.0.1 — последней.
 * Хэштегов нет. Каждое сообщение собрано настоящими функциями —
 * сводка `GET /api/chat/inbox` → `collectPendingAsks` → `sentItemOf` →
 * `messageText` — и сверено с точным текстом. Этот же набор гоняет
 * `tools/qa/telegram-format-mustfail.mjs`: каждая подложенная поломка обязана
 * сделать его красным.
 */

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const LINK = 'http://127.0.0.1:8888/chat?id=s1';
const OPEN = `<a href="${LINK}">Открыть чат →</a>`;

beforeEach(() => {
  vi.stubEnv('WEB_PORT', '8888');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function chat(asks: InboxAsk[], over: Partial<InboxChat> = {}): InboxChat {
  return {
    id: 's1',
    runKey: 'r',
    sessionId: 's1',
    title: 'Аудит проекта',
    project: 'atlas',
    projectPath: '/w/atlas',
    isSandbox: false,
    status: 'waiting',
    running: true,
    updatedAt: '2026-10-25T12:00:00Z',
    asks,
    ...over,
  };
}

/** Имена чатов панели по ключу и родитель группы — как их отдаёт сервер. */
const TITLES: Record<string, string> = { 'run-a': 'Починить вход', parent: 'Разделить задачу' };
const PARENTS: Record<string, string> = { 'group-chat': 'parent' };

function itemsOf(chats: InboxChat[], deferred: ChatInbox['deferred'] = []): PendingAskItem[] {
  return collectPendingAsks({
    inbox: { generatedAt: '', chats, deferred },
    foreign: [],
    defaultCli: 'Claude Code',
    cliName: (id) => id,
    titleOf: (chatId) => TITLES[chatId],
    parentOf: (chatId) => PARENTS[chatId],
  });
}

const permissionAsk = (toolName: string, input: unknown): InboxAsk => ({
  kind: 'permission',
  key: 'p',
  toolUseId: 't',
  toolName,
  input,
  askedAt: '2026-10-25T12:00:00Z',
});

function questionAsks(
  questions: { question: string; options: { label: string; description?: string }[] }[],
): InboxAsk[] {
  return questions.map((question, index) => ({
    kind: 'question',
    key: `q:t:${index}`,
    toolUseId: 't',
    index,
    total: questions.length,
    question: { ...question },
    askedAt: '2026-10-25T12:00:00Z',
  }));
}

const message = (items: SentItem[]): SentMessage => ({
  sid: '1',
  chatId: '4242',
  messageId: 1,
  nonce: 'n',
  sentAt: '2026-10-25T12:00:00.000Z',
  items,
  actions: {},
  nextAction: 0,
});

/** Сообщение об одном ожидании — как его отправит сервис. */
const render = (item: PendingAskItem): string => messageText(message([sentItemOf(item)]), [LINK]);

const one = (asks: InboxAsk[], over: Partial<InboxChat> = {}): string =>
  render(itemsOf([chat(asks, over)])[0]!);

const sign = (n: number) => `s${n}`;

/** Шапка сообщения о чате фикстуры: вид, проект с меткой папки, сессия. */
const head = (type: string, place = '📁 atlas · Аудит проекта') => `<b>${type} · ${place}</b>`;
/** Хвост любого сообщения о чате: пустая строка и ссылка — последней. */
const TAIL = ['', OPEN];

describe('золотая таблица: права', () => {
  it('Bash с описанием — описание второй строкой, команда в цитате', () => {
    expect(
      one([
        permissionAsk('Bash', {
          command: 'git add -A && git commit -m "x"',
          description: 'Закоммитить правки',
        }),
      ]),
    ).toBe(
      [
        head('🔐 РАЗРЕШЕНИЕ'),
        '<b>Закоммитить правки</b>',
        '<blockquote expandable><code>git add -A &amp;&amp; git commit -m "x"</code></blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('Bash без описания — суть сама команда кодом, не «Bash»; цитаты нет', () => {
    expect(one([permissionAsk('Bash', { command: 'ls -la <dir>' })])).toBe(
      [head('🔐 РАЗРЕШЕНИЕ'), '<b><code>ls -la &lt;dir&gt;</code></b>', ...TAIL].join('\n'),
    );
  });

  it('команда длиннее 80 — во второй строке обрезана, целиком в цитате', () => {
    const command = `npm run ${'build:'.repeat(20)}`;
    const lines = one([permissionAsk('Bash', { command })]).split('\n');
    expect(lines[1]).toBe(`<b><code>${command.slice(0, 79)}…</code></b>`);
    expect(lines[2]).toBe(`<blockquote expandable><code>${command}</code></blockquote>`);
  });

  it('Edit', () => {
    expect(one([permissionAsk('Edit', { file_path: '/w/atlas/src/app.ts' })])).toBe(
      [
        head('🔐 РАЗРЕШЕНИЕ'),
        '<b>Изменить файл app.ts</b>',
        '<blockquote expandable><code>/w/atlas/src/app.ts</code></blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('инструмент MCP', () => {
    expect(one([permissionAsk('mcp__gitlab__create_issue', { title: 'Bug' })])).toBe(
      [
        head('🔐 РАЗРЕШЕНИЕ'),
        '<b>gitlab: create_issue</b>',
        '<blockquote expandable><code>{"title":"Bug"}</code></blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('WebFetch', () => {
    expect(one([permissionAsk('WebFetch', { url: 'https://docs.example.com/a?b=1&c=2' })])).toBe(
      [
        head('🔐 РАЗРЕШЕНИЕ'),
        '<b>Открыть docs.example.com</b>',
        '<blockquote expandable><code>https://docs.example.com/a?b=1&amp;c=2</code></blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('цитаты нет, когда команда совпала с описанием', () => {
    expect(one([permissionAsk('Bash', { command: 'git status', description: 'git status' })])).toBe(
      [head('🔐 РАЗРЕШЕНИЕ'), '<b>git status</b>', ...TAIL].join('\n'),
    );
  });

  it('секрет в команде — под маской, и только потом экранирование', () => {
    const text = one([permissionAsk('Bash', { command: `curl -H "x: ${SECRET}" a<b` })]);
    expect(text).not.toContain('AAAAAAAA');
    expect(text).toContain('<code>curl -H "x: ••••••" a&lt;b</code>');
  });

  it('группа и стадия — в цитате, первая строка — сессия и проект', () => {
    const [item] = itemsOf([
      chat([permissionAsk('Bash', { command: 'npm test', description: 'Прогнать тесты' })], {
        source: {
          app: 'agentdeck',
          cli: 'Claude Code',
          group: { index: 1, title: 'API', stage: 'work' },
        },
      }),
    ]);
    expect(render(item!)).toBe(
      [
        head('🔐 РАЗРЕШЕНИЕ'),
        '<b>Прогнать тесты</b>',
        '<blockquote expandable><code>npm test</code>',
        'группа 1 «API» · стадия «работа»</blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('сессия из VS Code — «📁 atlas · VS Code · сессия»; чужой CLI — его имя; Claude Code не пишется', () => {
    const permission = permissionAsk('Bash', { command: 'make', description: 'Собрать' });
    expect(one([permission], { outside: true }).split('\n')[0]).toBe(
      head('🔐 РАЗРЕШЕНИЕ', '📁 atlas · VS Code · Аудит проекта'),
    );
    expect(one([permission], { source: { app: 'agentdeck', cli: 'Codex' } }).split('\n')[0]).toBe(
      head('🔐 РАЗРЕШЕНИЕ', '📁 atlas · Codex · Аудит проекта'),
    );
    expect(one([permission]).split('\n')[0]).toBe(head('🔐 РАЗРЕШЕНИЕ'));
  });

  it('имя сессии длиннее 40 — обрезано с «…»', () => {
    expect(one([permissionAsk('Bash', { command: 'ls' })], { title: 'б'.repeat(60) })).toMatch(
      new RegExp(`^<b>🔐 РАЗРЕШЕНИЕ · 📁 atlas · ${'б'.repeat(39)}…</b>\\n`),
    );
  });

  it('проект — сразу за видом и до сессии; проекта нет — метки нет', () => {
    const permission = permissionAsk('Bash', { command: 'make', description: 'Собрать' });
    const first = one([permission]).split('\n')[0]!;
    expect(first.indexOf('📁 atlas')).toBeGreaterThan(first.indexOf('РАЗРЕШЕНИЕ'));
    expect(first.indexOf('📁 atlas')).toBeLessThan(first.indexOf('Аудит проекта'));
    expect(one([permission], { project: '' }).split('\n')[0]).toBe(
      head('🔐 РАЗРЕШЕНИЕ', 'Аудит проекта'),
    );
  });

  it('в строке итога сессия — до 30 знаков, проект перед ней', () => {
    const [item] = itemsOf([
      chat([permissionAsk('Bash', { command: 'ls' })], { title: 'б'.repeat(50) }),
    ]);
    const done: SentItem = {
      ...sentItemOf(item!),
      state: 'done',
      outcome: OUTCOME.denied(new Date(2026, 9, 25, 15, 54).getTime()),
    };
    expect(messageText(message([done]), [LINK])).toBe(
      `⛔ Запрещено 15:54 · ls · 📁 atlas · ${'б'.repeat(29)}…`,
    );
  });

  it('после нажатия — сообщение сворачивается в строку итога, кнопок нет', () => {
    const [item] = itemsOf([chat([permissionAsk('Bash', { command: 'ls' })])]);
    const done: SentItem = {
      ...sentItemOf(item!),
      state: 'done',
      outcome: OUTCOME.allowed(new Date(2026, 9, 25, 15, 54).getTime()),
    };
    const text = messageText(message([done]), [LINK]);
    expect(text).toBe('✅ Разрешено 15:54 · ls · 📁 atlas · Аудит проекта');
    expect(keyboardOf(message([done]), sign)).toEqual([]);
  });

  it('сводное: отвеченное ожидание несёт строку итога, пока соседнее ждёт; кнопок у него нет', () => {
    const at = new Date(2026, 9, 25, 15, 54).getTime();
    const [first] = itemsOf([chat([permissionAsk('Bash', { command: 'git push' })])]);
    const [second] = itemsOf([
      chat([permissionAsk('Bash', { command: 'npm test' })], {
        id: 's2',
        sessionId: 's2',
        runKey: 'r2',
      }),
    ]);
    const done: SentItem = { ...sentItemOf(first!), state: 'done', outcome: OUTCOME.allowed(at) };
    const both = message([done, sentItemOf(second!)]);
    const text = messageText(both, [LINK, LINK]);
    expect(text).toContain('<b>1 · 🔐 РАЗРЕШЕНИЕ · 📁 atlas · Аудит проекта</b>');
    expect(text).toContain('✅ Разрешено · 15:54');
    expect(
      keyboardOf(both, sign)
        .flat()
        .map((button) => button.text),
    ).toEqual(['2 · ✅ Разрешить', '2 · ⛔ Запретить']);
  });

  it('сворачивание: итог и время, суть до 40, проект и сессия — одна строка на ожидание', () => {
    const at = new Date(2026, 9, 25, 15, 54).getTime();
    const [perm] = itemsOf([chat([permissionAsk('Bash', { command: 'git push' })])]);
    const [ask] = itemsOf([chat(questionAsks([{ question: 'Как карточка?', options: [] }]))]);
    const done = (item: PendingAskItem, outcome: string): SentItem => ({
      ...sentItemOf(item),
      state: 'done',
      outcome,
    });
    expect(messageText(message([done(perm!, OUTCOME.inPanel(at))]), [LINK])).toBe(
      '💻 Отвечено в панели 15:54 · git push · 📁 atlas · Аудит проекта',
    );
    expect(messageText(message([done(perm!, OUTCOME.stale(at))]), [LINK])).toBe(
      '⌛ Уже не актуально 15:54 · git push · 📁 atlas · Аудит проекта',
    );
    expect(
      messageText(
        message([done(perm!, OUTCOME.denied(at)), done(ask!, OUTCOME.answer('Хорошо', at))]),
        [LINK, LINK],
      ),
    ).toBe(
      '⛔ Запрещено 15:54 · git push · 📁 atlas · Аудит проекта\n' +
        '✅ Ответ: Хорошо 15:54 · Как карточка? · 📁 atlas · Аудит проекта',
    );
  });
});

describe('золотая таблица: вопросы', () => {
  it('вопрос длиной 700 знаков — один раз: 300 и «…полностью в панели»', () => {
    const question = `Начало ${'я'.repeat(700)}`;
    const text = one(questionAsks([{ question, options: [{ label: 'Да' }] }]));
    expect(text).toBe(
      [head('❓ ВОПРОС'), `<b>${question.slice(0, 300)}…полностью в панели</b>`, ...TAIL].join(
        '\n',
      ),
    );
    // Текст вопроса — ровно один раз: ни обрезка в шапке, ни повтор ниже.
    expect(text.split('Начало').length).toBe(2);
  });

  it('варианты с описанием — нумерованным списком; < > & и <script> экранированы', () => {
    expect(
      one(
        questionAsks([
          {
            question: 'Удалить <script>alert(1)</script> & всё?',
            options: [{ label: 'Да <b>', description: 'a & b' }, { label: 'Нет' }],
          },
        ]),
      ),
    ).toBe(
      [
        head('❓ ВОПРОС'),
        '<b>Удалить &lt;script&gt;alert(1)&lt;/script&gt; &amp; всё?</b>',
        '',
        '1. <b>Да &lt;b&gt;</b> — <i>a &amp; b</i>',
        '2. <b>Нет</b>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('варианты без описаний — списка нет, хватает кнопок', () => {
    const asks = questionAsks([
      { question: 'Как тебе новая карточка?', options: [{ label: 'Хорошо' }, { label: 'Плохо' }] },
    ]);
    expect(one(asks)).toBe(
      [head('❓ ВОПРОС'), '<b>Как тебе новая карточка?</b>', ...TAIL].join('\n'),
    );
    const [item] = itemsOf([chat(asks)]);
    expect(
      keyboardOf(message([sentItemOf(item!)]), sign)
        .flat()
        .map((button) => button.text),
    ).toEqual(['1. Хорошо', '2. Плохо', '✍️ Свой ответ']);
  });

  it('секрет в тексте вопроса и варианте — под маской (вопрос маскирует только сборка)', () => {
    const text = one(
      questionAsks([
        { question: `Ключ ${SECRET} подходит?`, options: [{ label: 'Да', description: SECRET }] },
      ]),
    );
    expect(text).not.toContain('AAAAAAAA');
    expect(text).toContain('<b>Ключ •••••• подходит?</b>');
    expect(text).toContain('1. <b>Да</b> — <i>••••••</i>');
  });

  it('несколько вопросов — «ВОПРОС 1/3» в виде; кнопки с номерами', () => {
    const [item] = itemsOf([
      chat(
        questionAsks([
          { question: 'Первый?', options: [{ label: 'А' }, { label: 'Б' }] },
          { question: 'Второй?', options: [{ label: 'В' }] },
          { question: 'Третий?', options: [{ label: 'Г' }] },
        ]),
      ),
    ]);
    const sent = sentItemOf(item!);
    expect(
      messageText(message([sent]), [LINK])
        .split('\n')
        .slice(0, 2),
    ).toEqual([head('❓ ВОПРОС 1/3'), '<b>Первый?</b>']);
    expect(
      keyboardOf(message([sent]), sign)
        .flat()
        .map((button) => button.text),
    ).toEqual(['1. А', '2. Б', '✍️ Свой ответ']);
  });
});

describe('золотая таблица: D-n, уведомления, предел', () => {
  it('D-n — «ОТЛОЖЕНО D-3», команда — суть, почему решаете вы и группа — в цитате', () => {
    const [item] = itemsOf(
      [],
      [
        {
          id: 'D-3',
          state: 'waiting',
          kind: 'permission',
          toolName: 'Bash',
          summary: 'npm publish',
          reason: 'not covered',
          reasonCode: 'not-auto-approved',
          askedAt: '2026-10-25T12:00:00Z',
          expiresAt: '2026-11-01T12:00:00Z',
          chatId: 's1',
          chatTitle: 'Релиз',
          project: 'shop',
          group: 2,
          groupTitle: 'Тесты',
        },
      ],
    );
    expect(render(item!)).toBe(
      [
        head('⏳ ОТЛОЖЕНО D-3', '📁 shop · Релиз'),
        '<b><code>npm publish</code></b>',
        '<blockquote expandable>Почему решаете вы: вызов не покрыт правилами автоподтверждения',
        'группа 2 «Тесты»</blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  const deferredOf = (over: Partial<NonNullable<ChatInbox['deferred']>[number]>) =>
    itemsOf(
      [],
      [
        {
          id: 'D-2',
          state: 'waiting',
          kind: 'permission',
          toolName: 'Bash',
          summary: 'grep -c "Аудит" changelog/entries/2026-10-25-telegram-bot.json',
          reason: 'not covered',
          reasonCode: 'not-auto-approved',
          askedAt: '2026-10-25T12:00:00Z',
          expiresAt: '2026-11-01T12:00:00Z',
          project: 'shop',
          ...over,
        },
      ],
    )[0]!;

  it('D-n без имени чата в записи (вызов субагента) — имя берётся по ключу чата', () => {
    expect(render(deferredOf({ chatId: 'run-a' })).split('\n')[0]).toBe(
      head('⏳ ОТЛОЖЕНО D-2', '📁 shop · Починить вход'),
    );
  });

  it('D-n: у чата своего имени нет — имя родителя; нет и его — только проект, без висящей «·»', () => {
    expect(render(deferredOf({ chatId: 'group-chat' })).split('\n')[0]).toBe(
      head('⏳ ОТЛОЖЕНО D-2', '📁 shop · Разделить задачу'),
    );
    expect(render(deferredOf({ chatId: 'unknown' })).split('\n')[0]).toBe(
      head('⏳ ОТЛОЖЕНО D-2', '📁 shop'),
    );
  });

  it('D-n: команда длиннее 80 — во второй строке обрезана, целиком в цитате', () => {
    const command = `grep -n "${'x'.repeat(90)}" changelog.json`;
    const lines = render(deferredOf({ chatId: 'run-a', summary: command })).split('\n');
    expect(lines[1]).toBe(`<b><code>${escapeHtml(command.slice(0, 79))}…</code></b>`);
    expect(lines[2]).toBe(
      '<blockquote expandable>Почему решаете вы: вызов не покрыт правилами автоподтверждения',
    );
    expect(lines[3]).toBe(`<code>${escapeHtml(command)}</code></blockquote>`);
  });

  it('Задача закрыта за 12 минут — итог фразой, «шёл 12 мин» обычным шрифтом, ссылка на 127.0.0.1', () => {
    expect(
      composeRich(
        {
          kind: 'done',
          chatId: 's1',
          projectPath: '/w/atlas',
          durationMs: 12 * 60_000,
          turn: {
            kind: 'closed',
            summary: 'Аудит закончен: 12 находок исправлены, MR !12 открыт.',
          },
        },
        'Аудит проекта',
      ),
    ).toBe(
      [
        head('✅ Задача закрыта'),
        'Аудит закончен: 12 находок исправлены, MR !12 открыт.',
        'шёл 12 мин',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('Агент ждёт вас — «Нужно решить:» жирным, варианты нумерованы, без вариантов — одна строка', () => {
    const waiting = (options: string[]) =>
      composeRich(
        {
          kind: 'done',
          chatId: 's1',
          projectPath: '/w/atlas',
          durationMs: 42 * 60_000,
          turn: { kind: 'waiting', ask: 'Опубликовать замечания тредами в MR?', options },
        },
        'Аудит проекта',
      );
    expect(waiting(['Да', 'Нет'])).toBe(
      [
        head('⏳ Агент ждёт вас'),
        '<b>Нужно решить:</b> Опубликовать замечания тредами в MR?',
        '1. Да',
        '2. Нет',
        'шёл 42 мин',
        ...TAIL,
      ].join('\n'),
    );
    expect(waiting([])!.split('\n').slice(1, 3)).toEqual([
      '<b>Нужно решить:</b> Опубликовать замечания тредами в MR?',
      'шёл 42 мин',
    ]);
  });

  it('ОШИБКА с длинной причиной — «Агент упал», в цитате только класс ошибки', () => {
    expect(
      composeRich(
        {
          kind: 'error',
          chatId: 's1',
          projectPath: '/w/atlas',
          errorText: `TypeError: Cannot read properties of undefined ${'x'.repeat(2000)} at /Users/me/a.ts`,
        },
        'Аудит проекта',
      ),
    ).toBe(
      [
        head('🛑 ОШИБКА'),
        '<b>Агент упал</b>',
        '<blockquote expandable>TypeError</blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('ТЕСТЫ — «5 из 120 упали»; чужой CLI — в скобках', () => {
    expect(
      composeRich(
        { kind: 'testFailed', chatId: 's1', projectPath: '/w/atlas', failed: 5, total: 120 },
        'Аудит проекта',
        undefined,
        'Codex',
      ),
    ).toBe(
      [head('🧪 ТЕСТЫ', '📁 atlas · Codex · Аудит проекта'), '<b>5 из 120 упали</b>', ...TAIL].join(
        '\n',
      ),
    );
  });

  it('ТРЕВОГА — что случилось словами, группа и правило в цитате', () => {
    expect(
      composeSignal({
        type: '⚠️ ТРЕВОГА',
        essence: 'группа молчит',
        session: 'Аудит проекта',
        project: 'atlas',
        details: 'группа 2 «API» · R1 · без событий 21 мин',
        openId: 's1',
      }),
    ).toBe(
      [
        head('⚠️ ТРЕВОГА'),
        '<b>группа молчит</b>',
        '<blockquote expandable>группа 2 «API» · R1 · без событий 21 мин</blockquote>',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('ни в одном виде нет «#», ссылка — последняя строка', () => {
    const texts = [
      one([permissionAsk('Bash', { command: 'ls' })], { project: '2026-plans' }),
      one(questionAsks([{ question: 'Да?', options: [{ label: 'Да', description: 'd' }] }])),
      composeRich({ kind: 'done', chatId: 's1', projectPath: '/w/atlas', durationMs: 60_000 })!,
      composeRich({ kind: 'error', chatId: 's1', projectPath: '/w/atlas' }, 'Аудит проекта')!,
    ];
    for (const text of texts) {
      expect(text).not.toContain('#');
      expect(text.split('\n').slice(-2)).toEqual(TAIL);
    }
  });

  it('много ожиданий — черта между ними, предел с тегами, теги не рвутся', () => {
    const items = Array.from({ length: 8 }, (_, at) =>
      sentItemOf(
        itemsOf([
          chat([permissionAsk('Bash', { command: `${'&'.repeat(590)} ${at}` })], {
            id: `s${at}`,
            sessionId: `s${at}`,
            runKey: `r${at}`,
          }),
        ])[0]!,
      ),
    );
    const text = messageText(
      message(items),
      items.map(() => LINK),
    );
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(text.startsWith('<b>Ждут ответа: 8</b>')).toBe(true);
    expect(text).toContain(`\n${DIVIDER}\n`);
    for (const tag of ['b', 'i', 'a', 'blockquote', 'code']) {
      expect(text.split(`<${tag}`).length, tag).toBe(text.split(`</${tag}>`).length);
    }
  });
});

describe('последний довод: не влезло даже одно ожидание', () => {
  it('уходит простым текстом — без тегов, с экранированными < и &, в пределе', () => {
    const options = Array.from({ length: 40 }, (_, at) => ({
      label: `<вариант ${at}> ${'x'.repeat(110)}`,
      description: `a & b ${'y'.repeat(150)}`,
    }));
    const text = one(questionAsks([{ question: 'Какой?', options }]));
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(text).not.toMatch(/<\/?(b|i|a|code|blockquote)[ >]/);
    expect(text).toContain('&lt;вариант 0&gt;');
    expect(text).toContain('a &amp; b');
  });
});

describe('экранирование и простой текст', () => {
  it('&, < и > — сущностями; обратно — без тегов', () => {
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
    expect(htmlToPlain('<b>1 &lt; 2</b>\n<a href="x">Открыть</a>')).toBe('1 < 2\nОткрыть');
  });

  function refusingHtml() {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.parse_mode === 'HTML') {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: can't parse entities: unclosed tag",
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: 1 } } }),
        );
      }),
    );
    return bodies;
  }

  it('разметку не разобрали — сообщение с кнопками и правка уходят простым текстом', async () => {
    const bodies = refusingHtml();
    const sent = await sendMessage('1:t', '1', '<b>1 &lt; 2</b>', { inline_keyboard: [] });
    expect(sent.ok).toBe(true);
    expect(bodies[0]!.parse_mode).toBe('HTML');
    expect(bodies[1]).toMatchObject({ text: '1 < 2', reply_markup: { inline_keyboard: [] } });
    expect(bodies[1]!.parse_mode).toBeUndefined();
    expect((await editMessageText('1:t', '1', 5, '<b>x &amp; y</b>', [])).ok).toBe(true);
    expect(bodies[3]).toMatchObject({ text: 'x & y' });
  });

  it('уведомление — тоже', async () => {
    const bodies = refusingHtml();
    expect(await deliverTelegram('1:t', '1', '<b>a &lt; b</b>')).toMatchObject({ ok: true });
    expect(bodies.map((body) => body.parse_mode)).toEqual(['HTML', undefined]);
    expect(bodies[1]!.text).toBe('a < b');
  });
});
