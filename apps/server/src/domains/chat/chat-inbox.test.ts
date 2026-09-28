import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSummary } from '@agentdeck/contracts';
import { AUTONOMOUS_PICK_MARKER } from '@agentdeck/contracts/chat-group-settings';
import type { Record } from './ChatRecords.ts';
import {
  ASKED_CACHE_MAX,
  buildInbox,
  createLastAskedReader,
  INBOX_LIMIT,
  lastAskedIn,
  parseQuestions,
  type InboxSources,
} from './chat-inbox.ts';

/**
 * Сводка ожиданий: кто ждёт человека, что идёт и что недавно молчит. Проверяем
 * то, от чего зависит правдивость экрана телефона: какой ответ снимает вопрос,
 * чей запрос прав показывается, как чат склеивается из прогона и транскрипта.
 */

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const summary = (over: Partial<ChatSummary> = {}): ChatSummary => ({
  id: 's1',
  title: 'Корзина',
  project: 'shop',
  projectPath: 'C:/work/shop',
  isSandbox: false,
  messageCount: 3,
  createdAt: iso(60),
  updatedAt: iso(5),
  ...over,
});

const sources = (over: Partial<InboxSources> = {}): InboxSources => ({
  chats: [],
  runs: [],
  permissions: [],
  lastAsked: () => undefined,
  now: NOW,
  ...over,
});

const ask = (id = 'q1'): Record => ({
  type: 'assistant',
  timestamp: iso(3),
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Какую?', options: [{ label: 'A' }] }] },
      },
    ],
  },
});
const result = (id: string, text: string, isError: boolean): Record => ({
  type: 'user',
  timestamp: iso(2),
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  } as Record['message'],
});

describe('lastAskedIn — что считается ответом на вопрос', () => {
  it('отказ брокера панели ответом не считается: вопрос ждёт', () => {
    const found = lastAskedIn([ask(), result('q1', 'ответ придёт следующим сообщением', true)]);
    expect(found).toMatchObject({ toolUseId: 'q1', askedAt: iso(3) });
  });

  it('реплика человека снимает вопрос', () => {
    const human: Record = { type: 'user', message: { content: 'A' } };
    expect(lastAskedIn([ask(), result('q1', 'x', true), human])).toBeUndefined();
  });

  it('выбор в терминале (результат без ошибки) снимает вопрос', () => {
    expect(lastAskedIn([ask(), result('q1', 'User answered: A', false)])).toBeUndefined();
  });

  it('автовыбор автономного чата снимает вопрос', () => {
    const picked = result('q1', `${AUTONOMOUS_PICK_MARKER}: picked A`, true);
    expect(lastAskedIn([ask(), picked])).toBeUndefined();
  });

  it('вопрос субагента (боковая ветка) человеку не адресован', () => {
    expect(lastAskedIn([{ ...ask(), isSidechain: true }])).toBeUndefined();
  });

  it('служебная запись не гасит вопрос', () => {
    const meta: Record = { type: 'user', isMeta: true, message: { content: 'caveat' } };
    expect(lastAskedIn([ask(), meta])?.toolUseId).toBe('q1');
  });
});

describe('parseQuestions — тело вызова пишет модель', () => {
  it('берёт вопросы с текстом, выкидывает пустые варианты', () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: 'Какую?',
          header: 'H',
          multiSelect: true,
          options: [{ label: 'A' }, { label: ' ' }],
        },
        { question: '' },
        'мусор',
      ],
    });
    expect(parsed).toEqual([
      { question: 'Какую?', header: 'H', multiSelect: true, options: [{ label: 'A' }] },
    ]);
  });

  it('не массив — нет вопросов', () => {
    expect(parseQuestions({ questions: 'x' })).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
  });
});

describe('buildInbox', () => {
  it('первый ход в git-копии без сводки числится за основной копией (F-68)', () => {
    // Раскладка git worktree на диске: `.git`-файл копии и `commondir` в
    // служебном каталоге — ровно то, что читает `layoutForCwd`.
    const root = mkdtempSync(join(tmpdir(), 'cc-inbox-copy-'));
    try {
      const main = join(root, 'shop');
      const copy = join(root, 'shop-feature');
      const admin = join(main, '.git', 'worktrees', 'shop-feature');
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, 'commondir'), '../..\n');
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, '.git'), `gitdir: ${admin}\n`);

      const inbox = buildInbox(
        sources({ runs: [{ key: 'new-1', cwd: copy, prompt: 'Почини', startedAt: NOW - 1_000 }] }),
      );

      expect(inbox.chats[0]).toMatchObject({
        project: 'shop',
        projectPath: copy,
        homeProjectPath: main,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('прогон и транскрипт — один чат: ключ прогона для прав, id сессии для открытия', () => {
    const inbox = buildInbox(
      sources({
        chats: [summary()],
        runs: [{ key: 'new-1', sessionId: 's1', startedAt: NOW - 60_000 }],
        permissions: [
          { runId: 'new-1', toolUseId: 't1', toolName: 'Bash', input: {}, askedAt: iso(1) },
        ],
      }),
    );
    expect(inbox.chats).toHaveLength(1);
    expect(inbox.chats[0]).toMatchObject({
      id: 's1',
      runKey: 'new-1',
      title: 'Корзина',
      status: 'waiting',
      running: true,
      asks: [{ kind: 'permission', key: 'p:t1' }],
    });
  });

  it('запрос прав без живого прогона не показывается', () => {
    const inbox = buildInbox(
      sources({
        chats: [summary()],
        permissions: [
          { runId: 's1', toolUseId: 't1', toolName: 'Bash', input: {}, askedAt: iso(1) },
        ],
      }),
    );
    expect(inbox.chats[0]?.asks).toEqual([]);
    expect(inbox.chats[0]?.status).toBe('idle');
  });

  it('ворота ветки — свой вид и свой ключ', () => {
    const inbox = buildInbox(
      sources({
        runs: [
          { key: 'k', startedAt: NOW, projectPath: 'C:/work/app', prompt: 'Почини\nподробно' },
        ],
        permissions: [
          {
            runId: 'k',
            toolUseId: 't2',
            toolName: 'Edit',
            input: {},
            askedAt: iso(0),
            kind: 'branchGate',
          },
        ],
      }),
    );
    // Чата без транскрипта нет в списке — название из первой строки задания.
    expect(inbox.chats[0]).toMatchObject({ id: 'k', title: 'Почини', project: 'app' });
    expect(inbox.chats[0]?.asks[0]).toMatchObject({ kind: 'branchGate', key: 'g:t2' });
  });

  it('вопрос из транскрипта — по строке на вопрос, со счётчиком', () => {
    const inbox = buildInbox(
      sources({
        chats: [summary()],
        lastAsked: () => ({
          toolUseId: 'q1',
          askedAt: iso(2),
          input: {
            questions: [
              { question: 'A?', options: [] },
              { question: 'B?', options: [] },
            ],
          },
        }),
      }),
    );
    expect(
      inbox.chats[0]?.asks.map((item) => [item.key, item.kind === 'question' && item.total]),
    ).toEqual([
      ['q:q1:0', 2],
      ['q:q1:1', 2],
    ]);
    expect(inbox.chats[0]?.status).toBe('waiting');
  });

  it('вопрос старше суток — брошенный разговор, не ожидание', () => {
    const inbox = buildInbox(
      sources({
        chats: [summary()],
        lastAsked: () => ({
          toolUseId: 'q1',
          askedAt: iso(25 * 60),
          input: { questions: [{ question: 'A?' }] },
        }),
      }),
    );
    expect(inbox.chats[0]?.asks).toEqual([]);
  });

  it('молчащий дольше суток разговор не попадает; идущий — попадает всегда', () => {
    const inbox = buildInbox(
      sources({
        chats: [
          summary({ id: 'old', updatedAt: iso(26 * 60) }),
          summary({ id: 'old-run', updatedAt: iso(48 * 60) }),
        ],
        runs: [{ key: 'old-run', sessionId: 'old-run', startedAt: NOW }],
      }),
    );
    expect(inbox.chats.map((chat) => chat.id)).toEqual(['old-run']);
  });

  it('порядок: ждущие, идущие, молчащие; молчащие — до предела', () => {
    const idle = Array.from({ length: INBOX_LIMIT + 5 }, (_, index) =>
      summary({ id: `i${index}`, updatedAt: iso(10 + index) }),
    );
    const inbox = buildInbox(
      sources({
        chats: [
          ...idle,
          summary({ id: 'run', updatedAt: iso(30) }),
          summary({ id: 'wait', updatedAt: iso(40) }),
        ],
        runs: [{ key: 'run', sessionId: 'run', startedAt: NOW - 30 * 60_000 }],
        lastAsked: (id) =>
          id === 'wait'
            ? { toolUseId: 'q', askedAt: iso(40), input: { questions: [{ question: 'A?' }] } }
            : undefined,
      }),
    );
    expect(inbox.chats.slice(0, 3).map((chat) => [chat.id, chat.status])).toEqual([
      ['wait', 'waiting'],
      ['run', 'running'],
      ['i0', 'idle'],
    ]);
    expect(inbox.chats).toHaveLength(INBOX_LIMIT);
  });
});

/**
 * F-147. Память читателя вопросов вытесняла по порядку ВСТАВКИ: чат, который
 * телефон спрашивает каждые секунды, уходил первым, как только набиралось
 * больше предела других, — и его каталог сканировался заново на каждом опросе.
 */
describe('createLastAskedReader: вытеснение по давности обращения', () => {
  it('часто спрашиваемый чат остаётся в памяти, уходит давно не спрошенный', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-inbox-lru-'));
    try {
      const project = join(dir, 'proj');
      mkdirSync(project);
      const ids = Array.from({ length: ASKED_CACHE_MAX + 1 }, (_, i) => `c${i}`);
      for (const id of ids) writeFileSync(join(project, `${id}.jsonl`), '');
      let scans = 0;
      const read = createLastAskedReader(() => {
        scans += 1;
        return dir;
      });
      read('c0');
      for (const id of ids.slice(1)) {
        read(id);
        read('c0');
      }
      // Каждый чат найден один раз; c0 между ними — только из памяти.
      expect(scans).toBe(ids.length);
      scans = 0;
      read('c1');
      expect(scans).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
