import { describe, expect, it } from 'vitest';
import type { InboxDeferred } from '@agentdeck/contracts/chat-inbox';
import {
  deferredDecisionBody,
  deferredDecisionPath,
  deferredReasonOf,
  openDeferred,
  waitingDeferred,
} from './deferred';
import { homeRu } from '../../shared/config/i18n/home/ru';

function item(id: string, state: InboxDeferred['state']): InboxDeferred {
  return {
    id,
    state,
    kind: 'permission',
    toolName: 'Bash',
    summary: 'npm publish',
    reason: 'публикация пакета',
    askedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-30T10:00:00.000Z',
  };
}

describe('D-n на телефоне', () => {
  it('открытые — ждущие первыми, затем истёкшие; выданное разрешение не показывается', () => {
    const items = [item('D-1', 'expired'), item('D-2', 'allowed'), item('D-3', 'waiting')];
    expect(openDeferred(items).map((entry) => entry.id)).toEqual(['D-3', 'D-1']);
  });

  it('в число на вкладке — только ждущие', () => {
    expect(waitingDeferred([item('D-1', 'waiting'), item('D-2', 'expired')])).toBe(1);
  });

  it('решение уходит маршрутом записи с подписью «телефон»', () => {
    expect(deferredDecisionPath('D-7')).toBe('/chat/deferred/D-7/decision');
    expect(deferredDecisionBody('allow')).toEqual({ behavior: 'allow', via: 'mobile' });
  });

  // Живой прогон 23.10: английская причина для агента стояла в русском списке.
  it('причина — по коду записи на языке телефона; без кода — текст записи как есть', () => {
    const grouped = {
      ...item('D-1', 'waiting'),
      reason: "the group's permission rows send this call to the human",
      reasonCode: 'group-rows' as const,
    };
    const guarded = {
      ...item('D-2', 'waiting'),
      reasonCode: 'backend-guard' as const,
      reasonParams: { rule: 'prod-target', match: 'prod.example.com' },
    };
    expect(deferredReasonOf(grouped, homeRu.deferredReasons)).toBe(
      'Правила прав группы отдают этот вызов человеку.',
    );
    expect(deferredReasonOf(guarded, homeRu.deferredReasons)).toBe(
      'Защита бэкенда: prod-target — «prod.example.com».',
    );
    expect(deferredReasonOf(item('D-3', 'waiting'), homeRu.deferredReasons)).toBe(
      'публикация пакета',
    );
  });
});
