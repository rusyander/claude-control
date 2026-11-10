import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import { inboxCreateBodySchema } from '@agentdeck/contracts/core/inbox';
import { boardMoveBodySchema } from '@agentdeck/contracts/core/panel-api';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
} from '@agentdeck/contracts/core/telegram-channel';
import { FORWARDED_PEER_HEADER } from '../../core-proxy/core-proxy.ts';
import { createTelegramCommandPort, telegramOwnerFingerprint } from './command-port.ts';

/**
 * Порт команд Telegram (этап 12, D29, P187, P190): строка ядра из `procs.json`, сверка слушателя,
 * число загрузки, свой отправитель с заголовками канала и отпечатком владельца из обновления.
 * Ядро — заглушка на настоящем HTTP, тела судит той же схемой контрактов, что живое ядро; подменена
 * только граница ОС (таблица слушателей), не клиент.
 */

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const ORIGIN = {
  apiBase: 'http://127.0.0.1:9/',
  botId: '1000001',
  chatId: '42',
  fromId: '42',
};
const TASK = '01900000-0000-7000-8000-0000000c0001';
const CMD = '01900000-0000-7000-8000-0000000c0002';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

async function fakeCore() {
  const home = mkdtempSync(join(tmpdir(), 'agentdeck-tg-port-'));
  const token = randomUUID();
  const minted = new Set<string>();
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, {});
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/nonce') {
        const nonce = randomUUID();
        minted.add(nonce);
        return send(200, { nonce });
      }
      const body = (await readBody(req)) as { proof?: { nonce?: string } };
      seen.push({ path: url.pathname, headers: req.headers, body });
      if (!body?.proof?.nonce || !minted.delete(body.proof.nonce)) {
        return send(403, { code: 'proof-required', error: 'no human proof' });
      }
      const parsed =
        url.pathname === '/v1/commands'
          ? parseCommand(body).ok
          : url.pathname === '/v1/inbox'
            ? inboxCreateBodySchema.safeParse(body).success
            : boardMoveBodySchema.safeParse(body).success;
      if (!parsed) return send(400, { code: 'bad-body', error: 'body refused' });
      if (url.pathname === '/v1/board/move') {
        return send(409, { code: 'move-not-allowed', error: 'not allowed', problems: ['queue'] });
      }
      return send(202, { ok: true });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, 'token'), token);
  writeFileSync(
    join(home, 'procs.json'),
    JSON.stringify({
      v: 1,
      cores: [
        {
          pid: process.pid,
          pidStart: 'fake',
          port,
          url: `http://127.0.0.1:${port}`,
          startedAt: Date.now(),
          home,
          portDecision: { rejected: [] },
          build: 'fake',
          bootId: 'fake',
        },
      ],
    }),
  );
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  };
  const port$ = createTelegramCommandPort({
    home: () => home,
    identity: () => ({
      tcp: async () => ({
        value: [{ state: 'listen', localAddress: '127.0.0.1', localPort: port, pid: process.pid }],
      }),
      isAlive: async () => 'alive',
      exists: async () => true,
    }),
  });
  return { seen, port: port$, home };
}

describe('telegram command port', () => {
  it('command: envelope accepted by the contract, channel + owner headers, no forwarded pid', async () => {
    const { seen, port } = await fakeCore();
    const outcome = await port.command(ORIGIN, {
      cmdId: CMD,
      kind: 'answer',
      taskId: TASK,
      fields: { askId: CMD, answer: 'refuse' },
    });
    expect(outcome).toEqual({ ok: true, status: 202, body: { ok: true } });
    expect(seen).toHaveLength(1);
    const [hit] = seen;
    expect(hit!.path).toBe('/v1/commands');
    expect(hit!.headers[HUMAN_CHANNEL_HEADER]).toBe('telegram');
    const expected = createHash('sha256').update('http://127.0.0.1:9|1000001|42|42').digest('hex');
    expect(hit!.headers[TELEGRAM_OWNER_HEADER]).toBe(expected);
    expect(hit!.headers[FORWARDED_PEER_HEADER]).toBeUndefined();
    expect(hit!.body).toMatchObject({ cmdId: CMD, kind: 'answer', target: { taskId: TASK } });
  });

  it('fingerprint follows the update: another chat gives another owner header', () => {
    const own = telegramOwnerFingerprint(ORIGIN);
    expect(telegramOwnerFingerprint({ ...ORIGIN, apiBase: 'http://127.0.0.1:9' })).toBe(own);
    expect(telegramOwnerFingerprint({ ...ORIGIN, chatId: '43' })).not.toBe(own);
    expect(telegramOwnerFingerprint({ ...ORIGIN, fromId: '43' })).not.toBe(own);
    expect(telegramOwnerFingerprint({ ...ORIGIN, botId: '1000002' })).not.toBe(own);
  });

  it('inbox-create: hand variant `telegram` accepted by inboxCreateBodySchema', async () => {
    const { seen, port } = await fakeCore();
    const outcome = await port.inboxCreate(ORIGIN, {
      cmdId: CMD,
      text: 'fix login',
      key: 'tg:42:7',
    });
    expect(outcome.ok).toBe(true);
    expect(seen[0]!.path).toBe('/v1/inbox');
    expect(seen[0]!.body).toMatchObject({
      create: { source: 'telegram', text: 'fix login', key: 'tg:42:7' },
    });
  });

  it('board work: a core refusal comes back as code and words', async () => {
    const { seen, port } = await fakeCore();
    const outcome = await port.boardWork(ORIGIN, { cmdId: CMD, entryId: TASK });
    expect(seen[0]!.body).toMatchObject({ to: 'work', entryId: TASK });
    expect(outcome).toEqual({
      ok: false,
      status: 409,
      code: 'move-not-allowed',
      message: 'not allowed: queue',
    });
  });

  it('no core: refusal `core-unreachable`, nothing sent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'agentdeck-tg-none-'));
    try {
      const port = createTelegramCommandPort({ home: () => empty });
      const outcome = await port.command(ORIGIN, {
        cmdId: CMD,
        kind: 'cancel',
        taskId: TASK,
        fields: { reason: 'x' },
      });
      expect(outcome).toMatchObject({ ok: false, status: 0, code: 'core-unreachable' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
