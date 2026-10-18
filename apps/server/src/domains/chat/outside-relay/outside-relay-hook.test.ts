import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'relay-hook-'));
  writeFileSync(join(home, 'api-token'), 'tok');
  takes = 0;
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

  it('конец хода спрашивает сервер всегда', async () => {
    await step('sess-1', 'Stop');
    expect(takes).toBe(1);
  });

  it('без метки сервера хук спрашивает каждый шаг', async () => {
    rmSync(join(home, 'outside-queue', '.server'));
    await step('sess-1');
    expect(takes).toBe(1);
  });
});
