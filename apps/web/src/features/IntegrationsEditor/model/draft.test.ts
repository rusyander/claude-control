import { describe, it, expect } from 'vitest';
import { DEFAULT_INTEGRATIONS, TELEGRAM_EVENTS } from '@entities/Integration';
import { draftFrom } from './draft';
import { toggleEvent } from './toggleEvent';
import { buildSettings } from './buildSettings';
import { isDraftDirty } from './isDraftDirty';
import { missingFields } from './missingFields';

describe('draftFrom', () => {
  it('раскладывает настройки коннектора по полям карточки', () => {
    const draft = draftFrom('jira', {
      enabled: true,
      baseUrl: 'https://site.atlassian.net',
      email: 'qa@example.com',
      deployment: 'cloud',
    });

    expect(draft).toEqual({
      baseUrl: 'https://site.atlassian.net',
      email: 'qa@example.com',
      deployment: 'cloud',
    });
  });

  it('флаг включённости в форму не попадает — у него свой переключатель', () => {
    expect(Object.keys(draftFrom('telegram', DEFAULT_INTEGRATIONS.telegram))).toEqual([
      'chatId',
      'doneAfterMinutes',
    ]);
  });

  it('порог «Закончил» у Telegram: не задан — 5 минут, задан — как есть', () => {
    expect(draftFrom('telegram', DEFAULT_INTEGRATIONS.telegram).doneAfterMinutes).toBe('5');
    expect(
      draftFrom('telegram', { ...DEFAULT_INTEGRATIONS.telegram, doneAfterMinutes: 0 })
        .doneAfterMinutes,
    ).toBe('0');
  });
});

describe('порог «Закончил» в минутах', () => {
  it('уходит числом; не число или больше суток — поле не заполнено', () => {
    expect(
      buildSettings({
        id: 'telegram',
        enabled: true,
        draft: { chatId: '42', doneAfterMinutes: ' 12 ' },
        events: [],
      }),
    ).toEqual({ enabled: true, chatId: '42', doneAfterMinutes: 12, events: [] });
    expect(missingFields('telegram', { chatId: '42', doneAfterMinutes: '0' })).toEqual([]);
    expect(missingFields('telegram', { chatId: '42', doneAfterMinutes: 'пять' })).toEqual([
      'doneAfterMinutes',
    ]);
    expect(missingFields('telegram', { chatId: '42', doneAfterMinutes: '1441' })).toEqual([
      'doneAfterMinutes',
    ]);
  });
});

describe('missingFields', () => {
  it('называет незаполненные обязательные поля', () => {
    expect(missingFields('zephyr', { projectKey: '', groupId: '' })).toEqual(['projectKey']);
  });

  it('пробелы не считаются заполнением', () => {
    expect(missingFields('confluence', { baseUrl: '   ' })).toEqual(['baseUrl']);
  });

  it('заполненное обязательное поле снимает запрет', () => {
    expect(missingFields('github', { repo: '' })).toEqual([]);
  });

  it('адрес тест-менеджмента обязателен только своей установке', () => {
    // Zephyr и Xray живут по общему адресу, и требовать его у них значило бы
    // не дать включить коннектор без выдуманного значения.
    expect(missingFields('xray', { projectKey: 'PRJ' })).toEqual([]);
    expect(missingFields('testit', { baseUrl: '', projectKey: 'PRJ' })).toEqual(['baseUrl']);
    expect(missingFields('testit', { baseUrl: 'https://testit.local', projectKey: 'PRJ' })).toEqual(
      [],
    );
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
        draft: { chatId: '@qa', doneAfterMinutes: '5' },
        events: ['runDone'],
      }),
    ).toEqual({ enabled: false, chatId: '@qa', doneAfterMinutes: 5, events: ['runDone'] });
    expect(
      buildSettings({
        id: 'github',
        enabled: false,
        draft: { repo: 'org/app' },
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
    const saved = { ...DEFAULT_INTEGRATIONS.github, repo: 'org/app' };
    expect(isDraftDirty('github', draftFrom('github', saved), saved)).toBe(false);
  });

  it('изменённое значение видно, а разница в пробелах — нет', () => {
    const saved = { ...DEFAULT_INTEGRATIONS.github, repo: 'org/app' };
    expect(isDraftDirty('github', { baseUrl: '', repo: ' org/app ' }, saved)).toBe(false);
    expect(isDraftDirty('github', { baseUrl: '', repo: 'org/other' }, saved)).toBe(true);
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
