import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ATTACHMENTS_MARKER } from '@agentdeck/contracts/uploads';
import { readChatMessages, readChats } from './ChatHistory.ts';

/**
 * Тесты пагинации ленты переписки. Ключевое: по умолчанию отдаётся хвост
 * (последние `limit` реплик), `offset` сдвигает окно к более ранним, `total` и
 * `hasMore` считаются верно, а окно вырезается из транскрипта, а не читается
 * целиком. Служебные записи (мета, результаты инструментов) в ленту не идут.
 *
 * Каждый тест поднимает свой временный каталог в роли ~/.claude/projects.
 */
describe('readChatMessages — пагинация', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-history-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Пишет транскрипт из N чередующихся реплик человек/агент с текстом m0..m{N-1}. */
  function writeDialog(session: string, count: number): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? 'user' : 'assistant',
          uuid: `u${i}`,
          cwd: 'C:/work/app',
          timestamp: `2026-07-18T10:${String(i).padStart(2, '0')}:00.000Z`,
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` },
        }),
      );
    }
    writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
  }

  /** Текст первого текстового блока реплики — по нему сверяем окно. */
  const textOf = (message: { blocks: { type: string }[] }): string => {
    const block = message.blocks.find((b) => b.type === 'text') as { text?: string } | undefined;
    return block?.text ?? '';
  };

  it('несуществующий чат — пустая страница', async () => {
    const page = await readChatMessages(projectsDir, 'nope');
    expect(page).toEqual({ messages: [], total: 0, hasMore: false });
  });

  it('по умолчанию отдаёт всю ленту, если она короче окна', async () => {
    writeDialog('s', 5);
    const page = await readChatMessages(projectsDir, 's', { limit: 400 });
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
    expect(page.messages.map(textOf)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('limit без offset — хвост ленты', async () => {
    writeDialog('s', 10);
    const page = await readChatMessages(projectsDir, 's', { limit: 3 });
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map(textOf)).toEqual(['m7', 'm8', 'm9']);
  });

  it('offset сдвигает окно к более ранним репликам', async () => {
    writeDialog('s', 10);
    const page = await readChatMessages(projectsDir, 's', { limit: 3, offset: 3 });
    expect(page.messages.map(textOf)).toEqual(['m4', 'm5', 'm6']);
    expect(page.hasMore).toBe(true);
  });

  it('окно, дошедшее до начала, гасит hasMore', async () => {
    writeDialog('s', 10);
    const page = await readChatMessages(projectsDir, 's', { limit: 3, offset: 9 });
    // endExcl = 1, start = 0 → остаётся только самая первая реплика.
    expect(page.messages.map(textOf)).toEqual(['m0']);
    expect(page.hasMore).toBe(false);
  });

  it('offset за пределами ленты — пустое окно без hasMore', async () => {
    writeDialog('s', 4);
    const page = await readChatMessages(projectsDir, 's', { limit: 3, offset: 10 });
    expect(page.messages).toEqual([]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it('растущий limit подтягивает более ранние поверх хвоста', async () => {
    writeDialog('s', 10);
    const first = await readChatMessages(projectsDir, 's', { limit: 4 });
    expect(first.messages.map(textOf)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(first.hasMore).toBe(true);

    const wider = await readChatMessages(projectsDir, 's', { limit: 8 });
    expect(wider.messages.map(textOf)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(wider.hasMore).toBe(true);
  });

  it('служебные записи в ленту и в total не попадают', async () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const lines = [
      // Мета-запись среды — не реплика.
      { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'служебное' } },
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'вопрос' } },
      // Результат инструмента у user — тоже не реплика.
      {
        type: 'user',
        uuid: 'tr',
        toolUseResult: { ok: true },
        message: { role: 'user', content: [{ type: 'tool_result', text: 'x' }] },
      },
      { type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: 'ответ' } },
    ].map((r) => JSON.stringify({ cwd: 'C:/work/app', ...r }));
    writeFileSync(join(dir, 's.jsonl'), `${lines.join('\n')}\n`);

    const page = await readChatMessages(projectsDir, 's', { limit: 400 });
    expect(page.total).toBe(2);
    expect(page.messages.map(textOf)).toEqual(['вопрос', 'ответ']);
  });
});

/**
 * Ветка в ленте и в списке. Claude Code пишет `gitBranch` в каждую строку
 * транскрипта, и именно этим панель отвечает на вопрос «когда он ушёл в другую
 * ветку»: живое состояние git знает только «сейчас».
 */
describe('ветка из транскрипта', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-branch-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Транскрипт, где ветка меняется посреди разговора. */
  function writeSwitching(session: string): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u0', gitBranch: 'main', message: { role: 'user', content: 'начали' } },
      {
        type: 'assistant',
        uuid: 'a0',
        gitBranch: 'main',
        message: { role: 'assistant', content: 'смотрю' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        gitBranch: 'feat/x',
        message: { role: 'assistant', content: 'ушёл в ветку' },
      },
    ].map((record) => JSON.stringify({ cwd: 'C:/work/app', ...record }));
    writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
  }

  it('каждая реплика несёт свою ветку — по ним лента и ставит отметку смены', async () => {
    writeSwitching('s');
    const page = await readChatMessages(projectsDir, 's', { limit: 400 });
    expect(page.messages.map((message) => message.gitBranch)).toEqual(['main', 'main', 'feat/x']);
  });

  it('транскрипт без веток оставляет поле пустым, а не пустой строкой', async () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'old.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: 'C:/work/app',
        message: { role: 'user', content: 'привет' },
      })}\n`,
    );

    const page = await readChatMessages(projectsDir, 'old', { limit: 400 });
    expect(page.messages[0]?.gitBranch).toBeUndefined();
  });

  it('в списке чатов стоит ПОСЛЕДНЯЯ ветка разговора, а не первая', () => {
    writeSwitching('s');
    const chats = readChats(projectsDir);
    expect(chats.find((chat) => chat.id === 's')?.branch).toBe('feat/x');
  });

  // Регрессия: вне репозитория CLI пишет `HEAD`, и список показывал «⎇ HEAD»
  // у каждого чата панели и у папок без git.
  it('HEAD — не ветка: пусто и в ленте, и в списке', async () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'nogit.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: 'C:/work/app',
        gitBranch: 'HEAD',
        message: { role: 'user', content: 'привет' },
      })}
`,
    );

    const page = await readChatMessages(projectsDir, 'nogit', { limit: 400 });
    expect(page.messages[0]?.gitBranch).toBeUndefined();
    expect(readChats(projectsDir).find((chat) => chat.id === 'nogit')?.branch).toBeUndefined();
  });
});

/**
 * Блок вложений дописывает к промпту сервер, и в транскрипте он лежит как
 * реплика человека. Название и превью — из текста ДО маркера: иначе заголовок
 * обрывался на «…Приложен», а превью показывало абсолютный путь.
 */
describe('название и превью без блока вложений', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-attach-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('заголовок и превью берутся из слов человека, пути вложений отброшены', () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const content = `опиши схему

${ATTACHMENTS_MARKER}
- C:\\chat\\схема.png`;
    writeFileSync(
      join(dir, 'att.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: 'C:/work/app',
        message: { role: 'user', content },
      })}
`,
    );

    const chat = readChats(projectsDir).find((item) => item.id === 'att');
    expect(chat?.title).toBe('опиши схему');
    expect(chat?.preview).toBe('опиши схему');
  });

  // Регрессия: реплика из одного знака названия не давала, и в списке стояло
  // кодированное имя папки проекта.
  it('реплика из одного символа даёт название, а не имя папки', () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'one.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: 'C:/work/app',
        message: { role: 'user', content: '?' },
      })}
`,
    );

    expect(readChats(projectsDir).find((item) => item.id === 'one')?.title).toBe('?');
  });

  it('одиночный знак уступает первому настоящему тексту', () => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const turn = (uuid: string, content: string): string =>
      JSON.stringify({
        type: 'user',
        uuid,
        cwd: 'C:/work/app',
        message: { role: 'user', content },
      });
    writeFileSync(
      join(dir, 'two.jsonl'),
      `${turn('u0', '.')}
${turn('u1', 'а теперь вопрос')}
`,
    );

    expect(readChats(projectsDir).find((item) => item.id === 'two')?.title).toBe('а теперь вопрос');
  });
});

describe('подпись «контур сжал историю»', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-summarized-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function write(records: unknown[]): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  const answer = (uuid: string, id: string, content: unknown[]): unknown => ({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-17T10:00:00.000Z',
    message: { id, role: 'assistant', content },
  });

  it('подписан ровно ответ с id из журнала, а не соседний', async () => {
    write([
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'раз' } },
      answer('a1', 'msg_c1-aaaaaaaaaaaa', [{ type: 'text', text: 'первый' }]),
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'два' } },
      answer('a3', 'msg_c1-bbbbbbbbbbbb', [{ type: 'text', text: 'второй' }]),
    ]);
    const page = await readChatMessages(projectsDir, 's', {
      summarizedIds: new Set(['msg_c1-bbbbbbbbbbbb']),
    });
    expect(page.messages.map((m) => [m.id, m.contextSummarized ?? false])).toEqual([
      ['u0', false],
      ['a1', false],
      ['u2', false],
      ['a3', true],
    ]);
  });

  it('ответ, записанный несколькими строками одного id, подписан один раз', async () => {
    write([
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'раз' } },
      answer('a1', 'msg_x-cccccccccccc', [{ type: 'thinking', thinking: 'думаю' }]),
      answer('a2', 'msg_x-cccccccccccc', [{ type: 'text', text: 'ответ' }]),
    ]);
    const page = await readChatMessages(projectsDir, 's', {
      summarizedIds: new Set(['msg_x-cccccccccccc']),
    });
    const flagged = page.messages.filter((m) => m.contextSummarized);
    expect(flagged).toHaveLength(1);
  });

  it('без журнала поля нет вовсе', async () => {
    write([answer('a1', 'msg_c1-aaaaaaaaaaaa', [{ type: 'text', text: 'ответ' }])]);
    const page = await readChatMessages(projectsDir, 's');
    expect(page.messages[0]).not.toHaveProperty('contextSummarized');
  });
});
