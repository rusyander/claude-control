import { describe, expect, it } from 'vitest';
import type { CapabilityStatus, ProviderInfo, ProvidersResponse } from '@agentdeck/contracts';
import { foreignChatSection } from './foreignSection';

/** Карточка провайдера: для секции важны только id, имя и статус чата. */
const card = (id: string, name: string, chat: CapabilityStatus): ProviderInfo =>
  ({ id, name, capabilities: { chat } }) as unknown as ProviderInfo;

/** Список как у сервера: Claude, CLI с чатом, Cursor без него, CLI «в разработке». */
const PROVIDERS = [
  card('claude', 'Claude Code', 'ready'),
  card('gemini', 'Gemini CLI', 'ready'),
  card('cursor', 'Cursor', 'unsupported'),
  card('future', 'Будущий CLI', 'planned'),
];

const answer = (active: string): ProvidersResponse => ({ active, providers: PROVIDERS });

/**
 * D3: у Cursor нет неинтерактивного запуска, сервер отказывает в разговоре, а
 * телефон показывал секцию с кнопкой «Новый разговор», которая вела к ошибке.
 */
describe('foreignChatSection', () => {
  it('CLI с готовым чатом — секция от его имени', () => {
    expect(foreignChatSection(answer('gemini'))).toEqual({ id: 'gemini', name: 'Gemini CLI' });
  });

  it('Cursor (чат unsupported) — секции нет', () => {
    expect(foreignChatSection(answer('cursor'))).toBeUndefined();
  });

  it('чат «в разработке» — секции нет: обещать разговор рано', () => {
    expect(foreignChatSection(answer('future'))).toBeUndefined();
  });

  it('активен Claude — секции нет, у него свой чат', () => {
    expect(foreignChatSection(answer('claude'))).toBeUndefined();
  });

  it('ответа ещё нет или карточки активного CLI в нём нет — секции нет', () => {
    expect(foreignChatSection(undefined)).toBeUndefined();
    expect(foreignChatSection(answer('unknown'))).toBeUndefined();
  });
});
