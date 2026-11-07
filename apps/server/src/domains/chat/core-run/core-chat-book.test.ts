import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coreChatBookKnows,
  coreChatBookPath,
  coreChatHistoryEntries,
  coreChatHistoryEntry,
  coreChatOfTask,
  createCoreChatBook,
} from './core-chat-book.ts';

/**
 * Книга чата ядра (W3-17a): CLI разговора переживает конец задачи и перезапуск панели, маршрут
 * отправки узнаёт разговор не-Claude CLI по файлу книги, а прежние записи без CLI читаются.
 */
describe('core chat book — the CLI of a conversation outlives its task', () => {
  const dirs: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'core-chat-book-'));
    dirs.push(dir);
    return coreChatBookPath(dir);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('forget drops the task and keeps the CLI; a reopened book still knows the CLI', () => {
    const file = fresh();
    const book = createCoreChatBook(file);
    book.set('conv-1', { taskId: 't1', stepId: 's1', cli: 'codex' });
    expect(book.get('conv-1')).toEqual({ taskId: 't1', stepId: 's1' });
    book.forget('conv-1');
    expect(book.get('conv-1')).toBeUndefined();
    expect(book.cliOf('conv-1')).toBe('codex');
    const reopened = createCoreChatBook(file);
    expect(reopened.get('conv-1')).toBeUndefined();
    expect(reopened.cliOf('conv-1')).toBe('codex');
  });

  it('a later set without a CLI keeps the recorded one', () => {
    const book = createCoreChatBook(fresh());
    book.set('conv-2', { taskId: 't1', stepId: 's1', cli: 'qwen' });
    book.set('conv-2', { taskId: 't2', stepId: 's2' });
    expect(book.cliOf('conv-2')).toBe('qwen');
    expect(book.get('conv-2')).toEqual({ taskId: 't2', stepId: 's2' });
  });

  it('an entry written before W3-17a (no CLI) reads as a live task with no CLI; a forgotten one is gone', () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ old: { taskId: 't0', stepId: 's0' } }));
    const book = createCoreChatBook(file);
    expect(book.get('old')).toEqual({ taskId: 't0', stepId: 's0' });
    expect(book.cliOf('old')).toBeUndefined();
    book.forget('old');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('coreChatBookKnows reads the file afresh: a conversation another instance wrote is known', () => {
    const file = fresh();
    expect(coreChatBookKnows(file, 'conv-3')).toBe(false);
    createCoreChatBook(file).set('conv-3', { taskId: 't', stepId: 's', cli: 'qwen' });
    expect(coreChatBookKnows(file, 'conv-3')).toBe(true);
    expect(coreChatBookKnows(file, '../conv-3')).toBe(false);
  });

  it('coreChatOfTask names the conversation a live task runs; a forgotten or unknown task names none', () => {
    const file = fresh();
    const book = createCoreChatBook(file);
    book.set('conv-a', { taskId: 'task-a', stepId: 's', cli: 'claude' });
    book.set('conv-b', { taskId: 'task-b', stepId: 's', cli: 'qwen' });
    expect(coreChatOfTask(file, 'task-b')).toBe('conv-b');
    expect(coreChatOfTask(file, 'task-a')).toBe('conv-a');
    expect(coreChatOfTask(file, 'task-zzz')).toBeUndefined();
    expect(coreChatOfTask(file, '../task-a')).toBeUndefined();
    book.forget('conv-a');
    expect(coreChatOfTask(file, 'task-a')).toBeUndefined();
  });

  // Волна 3: история разговора не-Claude CLI — виды сеансов ВСЕХ его задач, по порядку, и папка.
  it('every task that carried a conversation is kept in order with its folder, past forget and reopen', () => {
    const file = fresh();
    const book = createCoreChatBook(file);
    book.set('conv-q', { taskId: 't1', stepId: 's1', cli: 'qwen', cwd: 'C:/work/proj' });
    book.set('conv-q', { taskId: 't1', stepId: 's1' });
    book.forget('conv-q');
    book.set('conv-q', { taskId: 't2', stepId: 's2' });
    expect(coreChatHistoryEntry(file, 'conv-q')).toEqual({
      id: 'conv-q',
      cli: 'qwen',
      tasks: ['t1', 't2'],
      cwd: 'C:/work/proj',
    });
    // Повтор той же задачи (ход за ходом) не копится в файле: чтение схлопнуло бы повтор, а книга росла бы.
    expect(JSON.parse(readFileSync(file, 'utf8'))['conv-q'].tasks).toEqual(['t1', 't2']);
    book.forget('conv-q');
    const reopened = createCoreChatBook(file);
    expect(reopened.cliOf('conv-q')).toBe('qwen');
    expect(coreChatHistoryEntry(file, 'conv-q')?.tasks).toEqual(['t1', 't2']);
  });

  it('history entries are the non-Claude conversations only; an old entry lists its live task', () => {
    const file = fresh();
    writeFileSync(
      file,
      JSON.stringify({
        claude: { taskId: 'tc', stepId: 's', cli: 'claude', tasks: ['tc'] },
        bare: { taskId: 'tb', stepId: 's' },
        old: { taskId: 'to', stepId: 's', cli: 'codex' },
        gone: { cli: 'qwen' },
        junk: { taskId: 'tj', stepId: 's', cli: 'qwen', tasks: ['../x', 7, 'tj', 'tk'] },
      }),
    );
    expect(coreChatHistoryEntries(file)).toEqual([
      { id: 'old', cli: 'codex', tasks: ['to'] },
      { id: 'junk', cli: 'qwen', tasks: ['tj', 'tk'] },
    ]);
    expect(coreChatHistoryEntry(file, 'claude')).toBeUndefined();
    expect(coreChatHistoryEntry(file, 'gone')).toBeUndefined();
    expect(coreChatHistoryEntry(file, '../old')).toBeUndefined();
  });
});
