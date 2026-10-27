import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import { ru } from '../../shared/config/i18n/ru';
import { chatOrigin } from './chatOrigin';

/** Ветка правки реплики в списке телефона (Telegram 26.10, R2). */
const chat = (extra: Partial<ChatSummary> = {}): ChatSummary =>
  ({
    id: 'fork-1',
    title: 'Перенос среды между CLI',
    project: 'proj',
    projectPath: '/work/proj',
    isSandbox: false,
    updatedAt: '2026-10-26T10:00:00.000Z',
    messageCount: 108,
    ...extra,
  }) as ChatSummary;

describe('подпись строки списка разговоров', () => {
  it('ветка подписана названием исходного разговора', () => {
    expect(chatOrigin(chat({ forkOf: { id: 'o', title: 'Перенос среды' } }), ru.chats)).toBe(
      'ветка от «Перенос среды»',
    );
  });

  it('исходного нет в списке — подпись без названия', () => {
    expect(chatOrigin(chat({ forkOf: { id: 'o' } }), ru.chats)).toBe(ru.chats.forkOfUnknown);
  });

  it('обычный разговор — проект, песочница — песочница', () => {
    expect(chatOrigin(chat(), ru.chats)).toBe('proj');
    expect(chatOrigin(chat({ isSandbox: true }), ru.chats)).toBe(ru.chats.sandbox);
  });
});
