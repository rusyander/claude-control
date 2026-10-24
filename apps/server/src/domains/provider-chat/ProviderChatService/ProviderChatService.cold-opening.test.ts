import { describe, expect, it } from 'vitest';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { coldOpening } from './ProviderChatService.ts';

/**
 * @covers ProviderChatService.ts — `coldOpening`
 *
 * Новая сессия после паузы: вводная, хвост реплик, реплика человека. Строки
 * ленты (`notice`) — не реплики разговора и места хвоста не занимают (ревью A9).
 */
const msg = (id: string, role: ProviderChatMessage['role'], content = id): ProviderChatMessage => ({
  id,
  role,
  content,
  at: '2026-10-22T10:00:00.000Z',
});

describe('coldOpening', () => {
  it('brief, then the last dialogue replies, then the new message; notices skipped', () => {
    const history = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
      msg('n1', 'notice', 'Начат новый разговор'),
      msg('u3', 'user'),
    ];
    const out = coldOpening(history, { brief: 'BRIEF', tail: 2 });
    expect(out.map((item) => item.id)).toEqual(['cold-brief', 'u2', 'a2', 'u3']);
    expect(out[0]).toMatchObject({ role: 'user', content: 'BRIEF' });
  });

  it('tail 0 — brief and the new message only', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')];
    expect(coldOpening(history, { brief: 'B', tail: 0 }).map((item) => item.id)).toEqual([
      'cold-brief',
      'u2',
    ]);
  });
});
