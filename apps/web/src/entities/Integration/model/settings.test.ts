import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@agentdeck/contracts';
import { NOTIFY_EVENTS } from '@agentdeck/contracts/integrations';
import {
  DEFAULT_INTEGRATIONS,
  TELEGRAM_EVENTS,
  isLinkEmpty,
  readIntegration,
  readIntegrations,
} from './settings';

/** Настройки панели без секции интеграций — конфиг, заведённый прошлой версией. */
const bare = {} as AppSettings;

describe('readIntegrations', () => {
  it('без секции интеграций отдаёт умолчания, а не падает', () => {
    expect(readIntegrations(bare)).toEqual(DEFAULT_INTEGRATIONS);
    expect(readIntegrations(undefined)).toEqual(DEFAULT_INTEGRATIONS);
  });

  it('половина секции — вторая половина берётся из умолчаний', () => {
    const settings = {
      integrations: { atlassian: { enabled: true, baseUrl: 'https://site.atlassian.net' } },
    } as unknown as AppSettings;

    const result = readIntegrations(settings);
    expect(result.atlassian.enabled).toBe(true);
    expect(result.atlassian.baseUrl).toBe('https://site.atlassian.net');
    expect(result.atlassian.email).toBe('');
    expect(result.forge).toEqual(DEFAULT_INTEGRATIONS.forge);
  });

  it('чужое значение в закрытом списке читается как «не задано»', () => {
    const settings = {
      integrations: { forge: { kind: 'bitbucket' }, tms: { kind: 'zephyr' } },
    } as unknown as AppSettings;

    expect(readIntegrations(settings).forge.kind).toBe('');
    expect(readIntegrations(settings).tms.kind).toBe('zephyr');
  });

  it('своя установка тест-менеджмента приезжает вместе с адресом', () => {
    const settings = {
      integrations: { tms: { kind: 'testit', baseUrl: 'https://testit.local' } },
    } as unknown as AppSettings;

    expect(readIntegrations(settings).tms).toMatchObject({
      kind: 'testit',
      baseUrl: 'https://testit.local',
    });
  });

  it('события Telegram отбираются по списку и приходят в известном порядке', () => {
    const settings = {
      integrations: { telegram: { events: ['question', 'выдумка', 'runDone'] } },
    } as unknown as AppSettings;

    expect(readIntegrations(settings).telegram.events).toEqual(['runDone', 'question']);
  });

  it('не-строка и не-массив на месте значения не протекают наружу', () => {
    const settings = {
      integrations: { ci: { repo: 42, artifact: null }, telegram: { events: 'runDone' } },
    } as unknown as AppSettings;

    expect(readIntegrations(settings).ci.repo).toBe('');
    expect(readIntegrations(settings).ci.artifact).toBe('');
    expect(readIntegrations(settings).telegram.events).toEqual([]);
  });
});

/**
 * Список событий на вкладке — ПЕРЕСТАНОВКА источника, а не его копия.
 *
 * Порядок здесь свой (от частого к редкому) и меняться волен, а состав — нет:
 * `TELEGRAM_EVENTS` набран руками и типизирован как `readonly TelegramEvent[]`,
 * поэтому забытое событие не ловится ни типом, ни сборкой — оно просто не
 * показывается, и подписаться на него человек не может ничем. Лишнее же
 * попадает в настройки строкой, которой сервер не знает.
 */
describe('TELEGRAM_EVENTS', () => {
  it('те же события, что в NOTIFY_EVENTS: без пропущенных и без лишних', () => {
    expect([...TELEGRAM_EVENTS].sort()).toEqual([...NOTIFY_EVENTS].sort());
  });

  // Отдельной проверкой, а не второй строкой предыдущей: там она не дошла бы до
  // выполнения — повтор роняет сравнение составов раньше, и проверка, которая
  // не может покраснеть сама, ничего не доказывает.
  it('без повторов: одно событие — одна галочка', () => {
    expect(new Set(TELEGRAM_EVENTS).size).toBe(TELEGRAM_EVENTS.length);
  });
});

describe('readIntegration', () => {
  it('отдаёт настройки одного коннектора', () => {
    const settings = {
      integrations: { telegram: { enabled: true, chatId: '@qa' } },
    } as unknown as AppSettings;

    expect(readIntegration(settings, 'telegram')).toEqual({
      enabled: true,
      chatId: '@qa',
      events: [],
    });
  });
});

describe('isLinkEmpty', () => {
  it('нет привязки или все поля пусты — показывать нечего', () => {
    expect(isLinkEmpty(undefined)).toBe(true);
    expect(isLinkEmpty({})).toBe(true);
    expect(isLinkEmpty({ jiraIssueTitle: 'Заголовок без ключа' })).toBe(true);
  });

  it('любое содержательное поле делает привязку видимой', () => {
    expect(isLinkEmpty({ jiraIssueKey: 'QA-1' })).toBe(false);
    expect(isLinkEmpty({ confluencePageId: '42' })).toBe(false);
    expect(isLinkEmpty({ note: 'требования тут' })).toBe(false);
  });
});
