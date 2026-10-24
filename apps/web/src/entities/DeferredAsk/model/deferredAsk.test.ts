import { describe, expect, it } from 'vitest';
import type { DeferredAskView } from '@agentdeck/contracts/deferred-asks';
import { asksOfParent, openAsks, ownerKey, waitingCount } from './deferredAsk';

function ask(id: string, extra: Partial<DeferredAskView> = {}): DeferredAskView {
  return {
    id,
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'p1', groupIndex: 0 },
    toolName: 'Bash',
    summary: 'git push origin main',
    reason: 'delivery-human-destructive',
    askedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-30T10:00:00.000Z',
    source: {},
    ...extra,
  };
}

describe('список D-n: что видно человеку', () => {
  it('открытые — ждущие первыми, затем истёкшие; решённые и использованные не видны', () => {
    const items = [
      ask('D-1', { state: 'expired' }),
      ask('D-2', { state: 'allowed' }),
      ask('D-3'),
      ask('D-4', { state: 'denied' }),
      ask('D-5', { state: 'consumed' }),
      ask('D-6', { state: 'withdrawn' }),
    ];
    expect(openAsks(items).map((item) => item.id)).toEqual(['D-3', 'D-1']);
  });

  it('число на плашке — только ждущие: истёкшая запись агента не ждёт', () => {
    expect(waitingCount([ask('D-1'), ask('D-2', { state: 'expired' }), ask('D-3')])).toBe(2);
  });

  it('хаб родителя берёт записи своих групп, не чужого разделения и не одиночного чата', () => {
    const items = [
      ask('D-1'),
      ask('D-2', { scope: { kind: 'group', parentChatId: 'p2', groupIndex: 0 } }),
      ask('D-3', { scope: { kind: 'chat', chatKeys: ['p1'] } }),
    ];
    expect(asksOfParent(items, 'p1').map((item) => item.id)).toEqual(['D-1']);
  });

  it('владелец: группа — по номеру внутри разделения, чат — по первому ключу', () => {
    expect(
      ownerKey(ask('D-1', { scope: { kind: 'group', parentChatId: 'p1', groupIndex: 2 } })),
    ).toBe('group:p1:2');
    expect(ownerKey(ask('D-2', { scope: { kind: 'chat', chatKeys: ['s-1', 'new-1'] } }))).toBe(
      'chat:s-1',
    );
    expect(ownerKey(ask('D-3', { scope: { kind: 'chat', chatKeys: [] }, chatId: 'c9' }))).toBe(
      'chat:c9',
    );
  });
});
