import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChatMessages } from './ChatHistory.ts';

/**
 * Расход шага в ленте переписки.
 *
 * Ключевое: цифра берётся из транскрипта (`message.usage`), принадлежит
 * КОНКРЕТНОМУ сообщению, а не разговору целиком, и не появляется там, где её
 * нет, — у реплики человека и у пустого usage. Часовая доля записи в кэш
 * доезжает отдельным полем: без неё оценка стоимости занижена вдвое на этой
 * части.
 */
describe('readChatMessages — расход шага', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-usage-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function write(lines: unknown[]): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
  }

  const ask = {
    type: 'user',
    uuid: 'u0',
    cwd: 'C:/work/app',
    timestamp: '2026-07-18T10:00:00.000Z',
    message: { role: 'user', content: 'посчитай' },
  };

  it('расход ответа модели попадает в своё сообщение, у реплики человека его нет', async () => {
    write([
      ask,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'готово' }],
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 5600,
            cache_creation_input_tokens: 780,
          },
        },
      },
    ]);

    const page = await readChatMessages(projectsDir, 's');

    expect(page.messages[0]?.usage).toBeUndefined();
    expect(page.messages[1]?.usage).toEqual({
      input: 12,
      output: 34,
      cacheRead: 5600,
      cacheCreation: 780,
      cacheCreation1h: undefined,
      model: 'claude-opus-4-8',
    });
  });

  it('часовая доля записи в кэш доезжает отдельным полем', async () => {
    write([
      ask,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'готово' }],
          usage: {
            input_tokens: 0,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 900,
            cache_creation: { ephemeral_1h_input_tokens: 400 },
          },
        },
      },
    ]);

    const page = await readChatMessages(projectsDir, 's');

    expect(page.messages[1]?.usage?.cacheCreation).toBe(900);
    expect(page.messages[1]?.usage?.cacheCreation1h).toBe(400);
  });

  it('пустой usage (все нули) расходом не считается', async () => {
    // Иначе в ленте появился бы бейдж «0 токенов», читаемый как сбой подсчёта.
    write([
      ask,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'готово' }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    const page = await readChatMessages(projectsDir, 's');

    expect(page.messages[1]?.usage).toBeUndefined();
  });

  it('у каждого шага свой расход — соседние не смешиваются', async () => {
    write([
      ask,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-07-18T10:00:09.000Z',
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'вот список' }],
          usage: { input_tokens: 40, output_tokens: 50, cache_read_input_tokens: 60 },
        },
      },
    ]);

    const page = await readChatMessages(projectsDir, 's');

    expect(page.messages[1]?.usage?.output).toBe(2);
    expect(page.messages[1]?.usage?.model).toBe('claude-opus-4-8');
    expect(page.messages[2]?.usage?.output).toBe(50);
    expect(page.messages[2]?.usage?.model).toBe('claude-haiku-4-5');
  });
});
