import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
  telegramOwnerInput,
} from '@agentdeck/contracts/core/telegram-channel';
import { classifyPeer, FORWARDED_PEER_HEADER, type PeerDeps } from './auth.ts';

/**
 * Пир `telegram` (этап 12, D29, P187): только звено панели с обоими заголовками, без pid пира и с
 * отпечатком, равным ДЕЙСТВУЮЩЕМУ `telegram.owner`. Любая другая смесь — `untrusted-forward`:
 * заявка человека через Telegram без доказательства проходит только подпись устройства.
 */

const HOP = 7777;
const STRANGER = 4242;
const OWNER = createHash('sha256')
  .update(
    telegramOwnerInput({
      apiBase: 'http://127.0.0.1:9',
      botId: '100',
      chatId: '200',
      fromId: '200',
    }),
  )
  .digest('hex');
const OTHER = 'e'.repeat(64);

function request(headers: Record<string, string>): IncomingMessage {
  return {
    socket: {
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
      localPort: 5190,
      remotePort: 50_000,
    },
    headers,
  } as unknown as IncomingMessage;
}

function deps(direct: number | 'unknown', owner: (() => string | null) | undefined): PeerDeps {
  return {
    peerPid: async () => (direct === 'unknown' ? { unknown: 'table' } : { value: direct }),
    isSessionDescendant: async () => false,
    trustedHopPids: new Set([HOP]),
    ...(owner ? { telegramOwner: owner } : {}),
  };
}

const both = (owner = OWNER) => ({
  [HUMAN_CHANNEL_HEADER]: 'telegram',
  [TELEGRAM_OWNER_HEADER]: owner,
});

describe('classifyPeer: the telegram peer (stage 12, D29, P187)', () => {
  it('hop + both headers + the fingerprint of the applied owner → telegram', async () => {
    expect(
      await classifyPeer(
        request(both()),
        deps(HOP, () => OWNER),
      ),
    ).toBe('telegram');
  });

  it.each([
    ['fingerprint mismatch', both(OTHER), HOP, () => OWNER],
    ['config owner null (unset or drifted)', both(), HOP, () => null],
    ['no owner provider at all', both(), HOP, undefined],
    ['sender is not the panel hop', both(), STRANGER, () => OWNER],
    ['direct pid unknown', both(), 'unknown' as const, () => OWNER],
    ['only the channel header', { [HUMAN_CHANNEL_HEADER]: 'telegram' }, HOP, () => OWNER],
    ['only the owner header', { [TELEGRAM_OWNER_HEADER]: OWNER }, HOP, () => OWNER],
    [
      'channel header is not telegram',
      { ...both(), [HUMAN_CHANNEL_HEADER]: 'phone' },
      HOP,
      () => OWNER,
    ],
    [
      'a forwarded pid is also present',
      { ...both(), [FORWARDED_PEER_HEADER]: '55' },
      HOP,
      () => OWNER,
    ],
  ])('%s → untrusted-forward', async (_name, headers, direct, owner) => {
    expect(await classifyPeer(request(headers), deps(direct, owner))).toBe('untrusted-forward');
  });

  it('no channel headers: the hop without a forwarded pid stays unknown, as before stage 12', async () => {
    expect(
      await classifyPeer(
        request({}),
        deps(HOP, () => OWNER),
      ),
    ).toBe('unknown');
    expect(
      await classifyPeer(
        request({}),
        deps(STRANGER, () => OWNER),
      ),
    ).toBe('clear');
  });
});
