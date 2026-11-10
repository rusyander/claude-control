import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
} from '@agentdeck/contracts/core/telegram-channel';
import { FORWARDED_PEER_HEADER, forwardToCore, type CoreLocation } from './core-proxy.ts';

/**
 * P190 (этап 12, D29): канал «Telegram» ядру называет только порт команд опроса бота. Пересылка
 * прокладки строит заголовки сама из закрытого набора — заголовок канала или владельца, пришедший
 * от клиента, до ядра не доходит никак: у `CoreForward` нет поля «чужие заголовки».
 */

const core = { url: 'http://127.0.0.1:1', token: 'tok', entry: {} } as unknown as CoreLocation;

afterEach(() => vi.unstubAllGlobals());

function capture(): () => Record<string, string> {
  let seen: Record<string, string> = {};
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    seen = { ...(init.headers as Record<string, string>) };
    return Promise.resolve(new Response('{}'));
  });
  return () => seen;
}

describe('forwardToCore: закрытый набор заголовков (P190)', () => {
  it('со всеми полями пересылки — только bearer, тип тела, pid пира и номер строки', async () => {
    const seen = capture();
    await forwardToCore(core, {
      method: 'POST',
      path: '/v1/commands',
      body: { headers: { [HUMAN_CHANNEL_HEADER]: 'telegram', [TELEGRAM_OWNER_HEADER]: 'x' } },
      peerPid: 77,
      lastEventId: '5',
    });
    expect(Object.keys(seen()).sort()).toEqual(
      ['authorization', 'content-type', FORWARDED_PEER_HEADER, 'last-event-id'].sort(),
    );
    expect(seen()[HUMAN_CHANNEL_HEADER]).toBeUndefined();
    expect(seen()[TELEGRAM_OWNER_HEADER]).toBeUndefined();
  });

  it('чтение без тела — один bearer', async () => {
    const seen = capture();
    await forwardToCore(core, { method: 'GET', path: '/v1/tasks' });
    expect(Object.keys(seen())).toEqual(['authorization']);
  });
});
