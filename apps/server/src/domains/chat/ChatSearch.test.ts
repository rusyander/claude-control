import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  searchChats,
  messageText,
  buildChatSnippet,
  countOccurrences,
  collapse,
} from './ChatSearch.ts';

/**
 * Тесты полнотекстового поиска по телу переписки. Ключевое: совпадение
 * находится и в реплике человека, и в ответе агента; регистр не важен; вокруг
 * места совпадения строится сниппет; короткий запрос ничего не ищет; служебные
 * записи (мета, результаты инструментов) в поиск не идут; битая строка активной
 * сессии не роняет поиск.
 *
 * Каждый тест поднимает свой временный каталог в роли ~/.claude/projects и
 * убирает его за собой.
 */
describe('searchChats', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-chat-search-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Пишет транскрипт из заранее собранных записей в каталог проекта. */
  function writeTranscript(
    projectFolder: string,
    session: string,
    records: unknown[],
    cwd = 'C:/work/app',
  ): void {
    const dir = join(projectsDir, projectFolder);
    mkdirSync(dir, { recursive: true });
    const withCwd = records.map((record) =>
      typeof record === 'string' ? record : { cwd, ...(record as object) },
    );
    const body = withCwd
      .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
      .join('\n');
    writeFileSync(join(dir, `${session}.jsonl`), `${body}\n`);
  }

  const userLine = (text: string, session = 's'): unknown => ({
    type: 'user',
    uuid: `${session}-u`,
    timestamp: '2026-07-18T10:00:00.000Z',
    message: { role: 'user', content: text },
  });

  const assistantLine = (text: string, session = 's'): unknown => ({
    type: 'assistant',
    uuid: `${session}-a`,
    timestamp: '2026-07-18T10:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] },
  });

  it('находит совпадение в реплике человека', async () => {
    writeTranscript('enc-1', 's1', [
      userLine('Помоги настроить вебпак для сборки проекта', 's1'),
      assistantLine('Готово', 's1'),
    ]);

    const { hits } = await searchChats(projectsDir, 'вебпак');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('s1');
    expect(hits[0]?.role).toBe('user');
    expect(hits[0]?.matchCount).toBe(1);
    expect(hits[0]?.snippet.toLowerCase()).toContain('вебпак');
  });

  it('находит совпадение в ответе агента', async () => {
    writeTranscript('enc-2', 's2', [
      userLine('привет', 's2'),
      assistantLine('Вот функция мемоизации для кеша', 's2'),
    ]);

    const { hits } = await searchChats(projectsDir, 'мемоизации');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.role).toBe('assistant');
    expect(hits[0]?.snippet.toLowerCase()).toContain('мемоизации');
  });

  it('поиск не зависит от регистра', async () => {
    writeTranscript('enc-3', 's3', [userLine('Разбор DATABASE и миграций', 's3')]);

    const { hits } = await searchChats(projectsDir, 'database');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('s3');
  });

  it('короткий запрос (меньше порога) ничего не ищет', async () => {
    writeTranscript('enc-4', 's4', [userLine('aaa текст', 's4')]);

    expect((await searchChats(projectsDir, 'a')).hits).toEqual([]);
    expect((await searchChats(projectsDir, ' ')).hits).toEqual([]);
    expect((await searchChats(projectsDir, '')).hits).toEqual([]);
  });

  it('битая строка jsonl не роняет поиск и не мешает найти совпадение', async () => {
    writeTranscript('enc-5', 's5', [
      '{ это не JSON', // недописанная строка активной сессии
      userLine('строка с искомым словом рефакторинг здесь', 's5'),
      '', // пустая строка
    ]);

    const { hits } = await searchChats(projectsDir, 'рефакторинг');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('s5');
  });

  it('служебные записи в поиск не попадают', async () => {
    writeTranscript('enc-6', 's6', [
      { type: 'user', uuid: 's6-m', isMeta: true, message: { role: 'user', content: 'секрет' } },
      {
        type: 'user',
        uuid: 's6-tr',
        toolUseResult: { ok: true },
        message: { role: 'user', content: [{ type: 'tool_result', content: 'секрет' }] },
      },
    ]);

    expect((await searchChats(projectsDir, 'секрет')).hits).toEqual([]);
  });

  it('считает все вхождения запроса в переписке', async () => {
    writeTranscript('enc-7', 's7', [
      userLine('тест тест и ещё раз тест', 's7'),
      assistantLine('вот тебе тест', 's7'),
    ]);

    const { hits } = await searchChats(projectsDir, 'тест');
    expect(hits).toHaveLength(1);
    // Три в реплике человека плюс одно в ответе агента.
    expect(hits[0]?.matchCount).toBe(4);
  });

  it('несуществующая папка проектов → пустой результат', async () => {
    const { hits } = await searchChats(join(projectsDir, 'нет-такой'), 'что-нибудь');
    expect(hits).toEqual([]);
  });

  it('без совпадений возвращает пустой список и эхо запроса', async () => {
    writeTranscript('enc-8', 's8', [userLine('обычный разговор', 's8')]);

    const result = await searchChats(projectsDir, 'отсутствует');
    expect(result.query).toBe('отсутствует');
    expect(result.hits).toEqual([]);
  });
});

describe('messageText', () => {
  it('берёт текст строковой реплики человека', () => {
    expect(messageText({ type: 'user', message: { content: 'привет' } })).toEqual({
      role: 'user',
      text: 'привет',
    });
  });

  it('склеивает текстовые блоки и размышления ответа', () => {
    const result = messageText({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'думаю' },
          { type: 'text', text: 'ответ' },
        ],
      },
    });
    expect(result?.role).toBe('assistant');
    expect(result?.text).toContain('думаю');
    expect(result?.text).toContain('ответ');
  });

  it('мета-запись, результат инструмента и вызов инструмента отсекаются', () => {
    expect(messageText({ type: 'user', isMeta: true, message: { content: 'x' } })).toBeUndefined();
    expect(
      messageText({ type: 'user', toolUseResult: {}, message: { content: 'x' } }),
    ).toBeUndefined();
    expect(
      messageText({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    ).toBeUndefined();
    expect(
      messageText({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
    ).toBeUndefined();
  });

  it('не реплика диалога (тип не user/assistant) → undefined', () => {
    expect(messageText({ type: 'ai-title', message: { content: 'заголовок' } })).toBeUndefined();
  });
});

describe('buildChatSnippet', () => {
  it('обрамляет совпадение в середине многоточиями', () => {
    const long = `${'а'.repeat(100)} ключевое ${'б'.repeat(100)}`;
    const snippet = buildChatSnippet(long, 'ключевое');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('ключевое');
  });

  it('совпадение в начале — без левого многоточия', () => {
    const snippet = buildChatSnippet('ключевое слово и дальше текст', 'ключевое');
    expect(snippet.startsWith('…')).toBe(false);
    expect(snippet).toContain('ключевое');
  });

  it('короткий текст возвращается целиком', () => {
    expect(buildChatSnippet('короткий текст', 'текст')).toBe('короткий текст');
  });
});

describe('countOccurrences и collapse', () => {
  it('считает вхождения без учёта регистра', () => {
    expect(countOccurrences('Тест тест ТЕСТ', 'тест')).toBe(3);
    expect(countOccurrences('ничего', 'тест')).toBe(0);
    expect(countOccurrences('текст', '')).toBe(0);
  });

  it('схлопывает пробелы и переносы в одну строку', () => {
    expect(collapse('строка\n  с   переносами\tи табами')).toBe('строка с переносами и табами');
  });
});
