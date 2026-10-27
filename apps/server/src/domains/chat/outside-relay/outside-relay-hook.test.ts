import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutsideRelay } from './outside-relay.ts';

/**
 * Хук `PostToolUse` стоит на каждом шаге каждой сессии в терминале. Без флага
 * сессии он не должен ходить на сервер, а с флагом — обязан забрать сообщение:
 * промах здесь — либо HTTP на каждом шаге, либо сообщение с телефона, которое
 * агент получит только в конце хода. Проверка — настоящим процессом хука против
 * настоящей очереди за локальным HTTP-сервером.
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'outside-relay-hook.mjs');

let home: string;
let server: Server;
let base: string;
let relay: OutsideRelay;
let takes: number;
let bodies: Record<string, unknown>[];
let urls: string[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'relay-hook-'));
  writeFileSync(join(home, 'api-token'), 'tok');
  takes = 0;
  bodies = [];
  urls = [];
  relay = new OutsideRelay({
    enabled: () => true,
    ownSession: () => false,
    flagDir: join(home, 'outside-queue'),
  });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      takes += 1;
      urls.push(`${req.method} ${req.url}`);
      bodies.push(JSON.parse(body || '{}') as Record<string, unknown>);
      const { sessionId } = JSON.parse(body || '{}') as { sessionId: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ texts: relay.takeMessages(sessionId) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(home, { recursive: true, force: true });
});

function step(sessionId: string, event = 'PostToolUse'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'node',
      [HOOK, '--url', base, '--token-file', join(home, 'api-token')],
      { encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(JSON.stringify({ hook_event_name: event, session_id: sessionId }));
  });
}

describe('хук сообщений с телефона', () => {
  it('шаг без сообщения не ходит на сервер', async () => {
    expect(await step('sess-1')).toBe('');
    expect(takes).toBe(0);
  });

  it('сообщение в очереди забирается на ближайшем шаге, флаг снимается', async () => {
    relay.queue('sess-1', 'остановись');
    const out = await step('sess-1');
    expect(out).toContain('остановись');
    expect(takes).toBe(1);
    expect(await step('sess-1')).toBe('');
    expect(takes).toBe(1);
  });

  it('флаг чужой сессии не будит эту', async () => {
    relay.queue('sess-2', 'другой');
    expect(await step('sess-1')).toBe('');
    expect(takes).toBe(0);
  });

  it('конец хода спрашивает сервер всегда и называет событие — по нему «Закончил» в Telegram', async () => {
    await step('sess-1', 'Stop');
    expect(takes).toBe(1);
    expect(bodies[0]).toEqual({ sessionId: 'sess-1', event: 'Stop' });
  });

  it('без метки сервера хук спрашивает каждый шаг', async () => {
    rmSync(join(home, 'outside-queue', '.server'));
    await step('sess-1');
    expect(takes).toBe(1);
  });
});

/**
 * Свежая сессия VS Code (живой прогон 25.10, e6600235): хук `PermissionRequest`
 * не нашёл вызов в транскрипте за прежнюю секунду поисков, вопрос не попал в
 * пересылку, и ответ из Telegram ушёл копией сессии в панели. Запись о вызове
 * может лечь на диск позже старта хука — хук ждёт её до ~10 с.
 */
describe('хук вопросов: вызов появляется в транскрипте не сразу', () => {
  const ask = {
    questions: [{ question: 'Какой вариант выбираешь?', options: [{ label: 'Вариант A' }] }],
  };

  function permission(transcript: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'node',
        [HOOK, '--url', base, '--token-file', join(home, 'api-token')],
        { encoding: 'utf8' },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end(
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-vs',
          transcript_path: transcript,
          tool_name: 'AskUserQuestion',
          tool_input: ask,
        }),
      );
    });
  }

  const useLine = (id: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: ask }],
      },
    }) + '\n';

  it('файла транскрипта ещё нет, вызов дописан через 2 с — хук всё равно регистрирует вопрос', async () => {
    const transcript = join(home, 'sess-vs.jsonl');
    const late = setTimeout(() => writeFileSync(transcript, useLine('toolu_late')), 2000);
    try {
      await permission(transcript);
    } finally {
      clearTimeout(late);
    }
    expect(urls).toEqual(['POST /api/outside/asks']);
    expect(bodies[0]).toMatchObject({ toolUseId: 'toolu_late', sessionId: 'sess-vs' });
  }, 15_000);

  /**
   * Первый ход свежей сессии VS Code так, как он лёг на диск (018d29ca, f69f30e5,
   * 25.10): ~360 КБ вложений и `api-request-blob` до вызова, вызов — последней
   * строкой, и дописан он позже старта хука. Хвост 512 КБ его покрывает; не
   * хватало только времени.
   */
  it('первый ход: ~360 КБ записей, вызов дописан через 2 с после старта хука — регистрируется', async () => {
    const transcript = join(home, 'sess-vs.jsonl');
    const attachment = (type: string, size: number) =>
      JSON.stringify({
        type: 'attachment',
        entrypoint: 'claude-vscode',
        attachment: { type, content: 'x'.repeat(size) },
      });
    const head = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'user', entrypoint: 'claude-vscode', message: { content: 'выбери' } }),
      attachment('skill_listing', 68_000),
      attachment('instructions', 70_000),
      JSON.stringify({ type: 'api-request-shape', body: 'y'.repeat(82_000) }),
      JSON.stringify({ type: 'api-request-blob', body: 'z'.repeat(40_000) }),
      JSON.stringify({ type: 'api-request-blob', body: 'z'.repeat(46_000) }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Выбор варианта' }),
      JSON.stringify({
        type: 'assistant',
        entrypoint: 'claude-vscode',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Спрошу.' }] },
      }),
    ];
    writeFileSync(transcript, head.join('\n') + '\n');
    const late = setTimeout(() => appendFileSync(transcript, useLine('toolu_append')), 2000);
    try {
      await permission(transcript);
    } finally {
      clearTimeout(late);
    }
    expect(bodies[0]).toMatchObject({ toolUseId: 'toolu_append', sessionId: 'sess-vs' });
  }, 15_000);

  it('вызова так и нет — хук сдаётся сам, в пределах ~10 с, и сервер не зовёт', async () => {
    const started = Date.now();
    await permission(join(home, 'never.jsonl'));
    const spent = Date.now() - started;
    expect(urls).toEqual([]);
    expect(spent).toBeGreaterThanOrEqual(9_000);
    expect(spent).toBeLessThan(14_000);
  }, 20_000);
});
