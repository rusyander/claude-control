import { describe, it, expect } from 'vitest';
import { DEFAULT_INTEGRATIONS, TELEGRAM_EVENTS } from '@entities/Integration';
import { buildSettings, draftFrom, isDraftDirty, missingFields, toggleEvent } from './draft';

describe('draftFrom', () => {
  it('раскладывает настройки коннектора по полям карточки', () => {
    const draft = draftFrom('atlassian', {
      enabled: true,
      baseUrl: 'https://site.atlassian.net',
      email: 'qa@example.com',
      deployment: 'cloud',
      confluenceUrl: '',
    });

    expect(draft).toEqual({
      baseUrl: 'https://site.atlassian.net',
      email: 'qa@example.com',
      deployment: 'cloud',
      confluenceUrl: '',
    });
  });

  it('флаг включённости в форму не попадает — у него свой переключатель', () => {
    expect(Object.keys(draftFrom('telegram', DEFAULT_INTEGRATIONS.telegram))).toEqual(['chatId']);
  });
});

describe('missingFields', () => {
  it('называет незаполненные обязательные поля', () => {
    expect(missingFields('tms', { kind: '', projectKey: '', groupId: '' })).toEqual([
      'kind',
      'projectKey',
    ]);
  });

  it('пробелы не считаются заполнением', () => {
    expect(missingFields('atlassian', { baseUrl: '   ' })).toEqual(['baseUrl']);
  });

  it('заполненное обязательное поле снимает запрет', () => {
    expect(missingFields('forge', { kind: 'github' })).toEqual([]);
  });
});

describe('buildSettings', () => {
  it('обрезает края значений и несёт флаг включённости', () => {
    const settings = buildSettings({
      id: 'ci',
      enabled: true,
      draft: { kind: 'gitlab', repo: '  org/app  ', workflow: '', artifact: 'junit.xml' },
    });

    expect(settings).toEqual({
      enabled: true,
      kind: 'gitlab',
      repo: 'org/app',
      workflow: '',
      artifact: 'junit.xml',
    });
  });

  it('у Telegram к полям добавляются события, у прочих — нет', () => {
    expect(
      buildSettings({
        id: 'telegram',
        enabled: false,
        draft: { chatId: '@qa' },
        events: ['runDone'],
      }),
    ).toEqual({ enabled: false, chatId: '@qa', events: ['runDone'] });
    expect(
      buildSettings({
        id: 'forge',
        enabled: false,
        draft: { kind: 'github' },
        events: ['runDone'],
      }),
    ).not.toHaveProperty('events');
  });
});

describe('buildSettings: подписка вебхука', () => {
  it('вебхук уходит вместе со списком событий — как Telegram', () => {
    expect(
      buildSettings({
        id: 'webhook',
        draft: { url: ' https://hooks.acme/x ' },
        enabled: true,
        events: ['runError'],
      }),
    ).toEqual({ enabled: true, url: 'https://hooks.acme/x', events: ['runError'] });
  });
});

describe('isDraftDirty', () => {
  it('форма, равная сохранённому, правкой не считается', () => {
    const saved = { ...DEFAULT_INTEGRATIONS.forge, kind: 'github' as const, repo: 'org/app' };
    expect(isDraftDirty('forge', draftFrom('forge', saved), saved)).toBe(false);
  });

  it('изменённое значение видно, а разница в пробелах — нет', () => {
    const saved = { ...DEFAULT_INTEGRATIONS.forge, kind: 'github' as const, repo: 'org/app' };
    expect(isDraftDirty('forge', { kind: 'github', baseUrl: '', repo: ' org/app ' }, saved)).toBe(
      false,
    );
    expect(isDraftDirty('forge', { kind: 'gitlab', baseUrl: '', repo: 'org/app' }, saved)).toBe(
      true,
    );
  });
});

describe('toggleEvent', () => {
  it('добавляет и снимает, не задваивая', () => {
    expect(toggleEvent([], TELEGRAM_EVENTS, 'runDone')).toEqual(['runDone']);
    expect(toggleEvent(['runDone'], TELEGRAM_EVENTS, 'runDone')).toEqual([]);
  });

  it('порядок остаётся известным, а не порядком нажатий', () => {
    const chosen = toggleEvent(['question'], TELEGRAM_EVENTS, 'runDone');
    expect(chosen).toEqual(['runDone', 'question']);
  });
});
