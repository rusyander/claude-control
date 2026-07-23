import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChatMessages } from './ChatHistory.ts';

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
