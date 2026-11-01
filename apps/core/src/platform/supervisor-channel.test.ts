import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { channelPath } from './control-channel.ts';
import { currentOs } from './os-kind.ts';
import {
  MAX_HOPS,
  openSupervisorChannel,
  proofOf,
  type HopsReply,
  type SupervisorChannel,
} from './supervisor-channel.ts';

/**
 * Канал надзора (P131): право записать звенья даёт только знание `supervisor-token`, токен по
 * каналу не ходит, ответ ядра доказан тем же токеном над числом клиента. Клиент здесь — сырой
 * сокет теста (настоящий клиент панели, `hop-recorder.mjs`, гоняется в интеграции P131).
 */

const TOKEN = randomBytes(32).toString('base64url');
let channel: SupervisorChannel | undefined;
afterEach(async () => {
  await channel?.close();
  channel = undefined;
});

function pathFor(): string {
  return currentOs() === 'win32'
    ? channelPath(`sup-${newId()}`)
    : channelPath(`sup-${newId().slice(0, 8)}`, currentOs(), '/tmp');
}

/** Один обмен: hello → просьба (её строит `make` по числу ядра) → ответ. */
function exchange(
  path: string,
  make: (hello: string, nonce: string) => object | string,
): Promise<{ hello: string; nonce: string; raw: { body: string; proof: string }; wire: string }> {
  return new Promise((done, fail) => {
    const socket = connect(path);
    const nonce = randomBytes(16).toString('hex');
    let buffer = '';
    let hello = '';
    let wire = '';
    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      wire += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const message = JSON.parse(line) as { hello?: string; body?: string; proof?: string };
        if (message.hello !== undefined) {
          hello = message.hello;
          const request = make(hello, nonce);
          socket.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`);
        } else {
          socket.destroy();
          done({ hello, nonce, raw: message as { body: string; proof: string }, wire });
        }
      }
    });
  });
}

describe('supervisor channel: mutual HMAC, the token never crosses the wire (P131)', () => {
  it('a proof by the token reaches the handler and the reply is proven over the client nonce', async () => {
    const asked: number[][] = [];
    const path = pathFor();
    channel = await openSupervisorChannel({
      path,
      token: TOKEN,
      handler: {
        hopsSet: async (pids) => {
          asked.push([...pids]);
          return { ok: true, accepted: [...pids], refused: [], recordedAt: 1 };
        },
      },
    });
    const got = await exchange(path, (hello, nonce) => ({
      op: 'hops.set',
      hops: [11, 22],
      nonce,
      proof: proofOf(TOKEN, ['hops.set', hello, nonce, '11,22']),
    }));
    expect(asked).toEqual([[11, 22]]);
    expect(JSON.parse(got.raw.body)).toMatchObject({ ok: true, accepted: [11, 22] });
    expect(got.raw.proof).toBe(proofOf(TOKEN, ['reply', got.nonce, got.raw.body]));
    expect(got.wire).not.toContain(TOKEN);
  });

  it('a wrong token, a replayed hello, too many hops and a bad op never reach the handler', async () => {
    let calls = 0;
    const path = pathFor();
    channel = await openSupervisorChannel({
      path,
      token: TOKEN,
      handler: {
        hopsSet: async () => {
          calls += 1;
          return { ok: true, accepted: [], refused: [], recordedAt: 1 };
        },
      },
    });
    const body = async (make: (hello: string, nonce: string) => object | string) =>
      JSON.parse((await exchange(path, make)).raw.body) as HopsReply;

    expect(
      await body((hello, nonce) => ({
        op: 'hops.set',
        hops: [11],
        nonce,
        proof: proofOf('another-token', ['hops.set', hello, nonce, '11']),
      })),
    ).toMatchObject({ ok: false, code: 'bad-proof' });
    // Доказательство над чужим числом ядра (подслушанный обмен) — не годится для нового.
    const first = await exchange(path, (hello, nonce) => ({
      op: 'hops.set',
      hops: [11],
      nonce,
      proof: proofOf('x', [hello]),
    }));
    expect(
      await body((_hello, nonce) => ({
        op: 'hops.set',
        hops: [11],
        nonce,
        proof: proofOf(TOKEN, ['hops.set', first.hello, nonce, '11']),
      })),
    ).toMatchObject({ ok: false, code: 'bad-proof' });
    const many = Array.from({ length: MAX_HOPS + 1 }, (_, i) => i + 1);
    expect(
      await body((hello, nonce) => ({
        op: 'hops.set',
        hops: many,
        nonce,
        proof: proofOf(TOKEN, ['hops.set', hello, nonce, many.join(',')]),
      })),
    ).toMatchObject({ ok: false, code: 'bad-hops' });
    expect(
      await body((hello, nonce) => ({
        op: 'hops.add',
        hops: [11],
        nonce,
        proof: proofOf(TOKEN, ['hops.add', hello, nonce, '11']),
      })),
    ).toMatchObject({ ok: false, code: 'bad-op' });
    expect(await body(() => 'not json')).toMatchObject({ ok: false, code: 'bad-request' });
    expect(calls).toBe(0);
  });
});
