import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../providers/registry.ts';
import type { ConfigProvider, ProviderStdoutParser } from '../../providers/types.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './ProviderChatRun.ts';

/**
 * `assistant.parseStdout` — единственная точка, где stdout одиночного запуска
 * превращается в ответ. Подменён только процесс CLI (внешняя граница); разбор
 * идёт настоящим путём `runStreaming`.
 */

function fakeSpawn(chunks: string[], code: number = 0, stderr = '') {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, 0);
    return child;
  }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];
}

/** Разборщик-образец: выбрасывает строки `CHROME:`, держит недочитанную строку. */
function chromeStripper(): ProviderStdoutParser {
  let pending = '';
  const keep = (line: string) => (line.startsWith('CHROME:') ? '' : `${line}\n`);
  return {
    push(chunk) {
      const lines = `${pending}${chunk}`.split('\n');
      pending = lines.pop() ?? '';
      return lines.map(keep).join('');
    },
    end() {
      const last = pending;
      pending = '';
      return last ? keep(last).replace(/\n$/, '') : '';
    },
  };
}

describe('ProviderChatRun: assistant.parseStdout', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-stdout-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const run = async (provider: ConfigProvider, chunks: string[], code = 0, stderr = '') => {
    const events: ProviderChatRunEvent[] = [];
    await new ProviderChatRun().start(
      {
        provider,
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        spawnImpl: fakeSpawn(chunks, code, stderr),
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return events;
  };

  // Образцы: у qwen разборщика нет, разборщик-образец подставляется ему же.
  const qwen = getProvider('qwen');
  const chunks = ['CHROME: старт\nОт', 'вет\nCHROME: конец\nхвост'];

  it('разбор задан: показ и ответ — только то, что вернул разборщик; один разборщик на прогон', async () => {
    let made = 0;
    const base = qwen.assistant;
    if (!base) throw new Error('у qwen нет assistant');
    const provider: ConfigProvider = {
      ...qwen,
      assistant: {
        ...base,
        parseStdout: () => {
          made += 1;
          return chromeStripper();
        },
      },
    };
    const events = await run(provider, chunks);
    const deltas = events.flatMap((event) => (event.type === 'delta' ? [event.text] : []));
    expect(deltas.join('')).toBe('Ответ\nхвост');
    expect(deltas.some((text) => text.includes('CHROME'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', reply: 'Ответ\nхвост' });
    expect(made).toBe(1);
  });

  it('разбора нет: stdout и есть ответ, как до хука', async () => {
    expect(qwen.assistant?.parseStdout).toBeUndefined();
    const events = await run(qwen, chunks);
    const deltas = events.flatMap((event) => (event.type === 'delta' ? [event.text] : []));
    expect(deltas).toEqual(chunks);
    expect(events.at(-1)).toMatchObject({ type: 'done', reply: chunks.join('').trim() });
  });

  // gemini 0.62.0 на win32: ответ и `result: success` напечатаны, затем падение
  // на выходе (0xC0000409). Поток — настоящий вывод CLI.
  const stream = readFileSync(
    new URL('../../providers/catalog/__fixtures__/gemini-0.62-stream-json.jsonl', import.meta.url),
    'utf8',
  );
  const CRASH = 3221226505;
  const ASSERT = 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)';

  it('CLI сказал «ход удался», потом упал на выходе — ответ цел, не ошибка', async () => {
    const events = await run(getProvider('gemini'), [stream], CRASH, ASSERT);
    expect(events.at(-1)).toMatchObject({ type: 'done', reply: 'AFTER_TOOL' });
  });

  it('без `result: success` ненулевой код — ошибка, как раньше', async () => {
    const cut = stream
      .split('\n')
      .filter((line) => !line.includes('"type":"result"'))
      .join('\n');
    const events = await run(getProvider('gemini'), [cut], CRASH, ASSERT);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
});
