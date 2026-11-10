import { createHash } from 'node:crypto';
import type { InboxCreate } from '@agentdeck/contracts/core/inbox';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
  telegramOwnerInput,
} from '@agentdeck/contracts/core/telegram-channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxPort } from '../conductor/inbox/inbox.types.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, TOKENS, TRUSTED_HOP_PID, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Запись во «Входящие» из Telegram через настоящий Fastify ядра (этап 12, W2-D F2, D29, M5): пир
 * `telegram` (звено панели + заголовки канала + отпечаток владельца) пишет только запись рукой
 * `source: 'telegram'`. Записи из поиска (`source: 'search'`, тикеты произвольного источника) —
 * отказ `telegram-binding` ДО порта: сессия на этой машине не протащит чужие тикеты на доску под
 * видом человека из Telegram. Порт входящих — записывающая заглушка: судят ручка и суд области.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const OWNER = createHash('sha256')
  .update(
    telegramOwnerInput({ apiBase: 'http://127.0.0.1:9', botId: '1', chatId: '2', fromId: '2' }),
  )
  .digest('hex');

function recordingInbox(): { port: InboxPort; created: InboxCreate[] } {
  const created: InboxCreate[] = [];
  const port: InboxPort = {
    search: async () => ({ ok: true, reply: { items: [], truncated: false } as never }),
    create: async (input) => {
      created.push(input.create);
      return { ok: true, reply: { created: ['e1'], existing: [], replayed: false } };
    },
  };
  return { port, created };
}

async function post(s: Stand, create: InboxCreate, telegram: boolean) {
  const res = await fetch(`${s.url}/v1/inbox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKENS.core}`,
      ...(telegram ? { [HUMAN_CHANNEL_HEADER]: 'telegram', [TELEGRAM_OWNER_HEADER]: OWNER } : {}),
    },
    body: JSON.stringify({ cmdId: newId(), proof: await s.nonce(), create }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SEARCH: InboxCreate = {
  source: 'search',
  sourceId: 'jira-main',
  items: [
    {
      sourceId: 'jira-main',
      system: 'jira',
      key: 'PROJ-2',
      kind: 'issue',
      title: 'Login button does nothing',
      url: 'https://tracker.example.com/browse/PROJ-2',
      labels: [],
      digest: 'a'.repeat(64),
      related: { links: [], paths: [] },
    },
  ],
};
const HAND: InboxCreate = { source: 'telegram', text: 'Почини вход', key: 'tg:2:41' };

describe('POST /v1/inbox from the Telegram peer (stage 12, W2-D F2, D29)', () => {
  it('a Telegram hand entry is accepted; search entries are refused before the inbox port', async () => {
    const inbox = recordingInbox();
    stand = await startStand(undefined, { telegramOwner: () => OWNER, inbox: () => inbox.port });
    stand.peer.direct = TRUSTED_HOP_PID;

    const refused = await post(stand, SEARCH, true);
    expect(refused).toMatchObject({ body: { code: 'telegram-binding' } });
    expect(refused.status).not.toBe(200);
    expect(inbox.created).toEqual([]);

    const accepted = await post(stand, HAND, true);
    expect(accepted).toMatchObject({ status: 200, body: { created: ['e1'] } });
    expect(inbox.created).toEqual([HAND]);
  });

  it('the panel (no Telegram headers) still creates search entries', async () => {
    const inbox = recordingInbox();
    stand = await startStand(undefined, { telegramOwner: () => OWNER, inbox: () => inbox.port });
    stand.peer.direct = TRUSTED_HOP_PID;
    const made = await post(stand, SEARCH, false);
    expect(made.status).toBe(200);
    expect(inbox.created).toEqual([SEARCH]);
  });
});
