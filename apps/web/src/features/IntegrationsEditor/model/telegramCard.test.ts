import { describe, expect, it, vi } from 'vitest';
import type { IntegrationStatus, TelegramSettings } from '@agentdeck/contracts';
import type { TelegramAnswersView } from '@agentdeck/contracts/telegram-answers';
import {
  answersBody,
  cardHealth,
  draftOfTelegram,
  groupsOf,
  isTelegramConnected,
  notifyBody,
  saveTelegramCard,
} from './telegramCard';

/**
 * Карточка Telegram после жалобы владельца «мешанина»: три понятные группы
 * вместо шести технических галочек, одно «Сохранить» на обе настройки, одно
 * слово о здоровье связи. Здесь — чистая часть: группы ↔ события, черновик ↔
 * два тела запроса, порядок сохранения и что говорить при сбое.
 */

const settings = (over: Partial<TelegramSettings> = {}): TelegramSettings => ({
  enabled: true,
  chatId: '777',
  events: ['runError', 'testFailed', 'budget', 'groupSignal'],
  ...over,
});
const answers = (over: Partial<TelegramAnswersView['settings']> = {}) => ({
  enabled: false,
  afterMinutes: 3,
  ownerId: '777',
  ownerName: '',
  ...over,
});
const status = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
  id: 'telegram',
  enabled: true,
  hasToken: true,
  maskedToken: '700…0000',
  state: 'ok',
  detail: '',
  account: '@deck_bot',
  ...over,
});

describe('группы «Когда звать» и события', () => {
  it('группа отмечена, только если отмечены все её события', () => {
    expect(groupsOf(['permission', 'question', 'runError', 'testFailed', 'groupSignal'])).toEqual({
      waits: true,
      broken: true,
      budget: false,
    });
    expect(groupsOf(['permission', 'runError'])).toEqual({
      waits: false,
      broken: false,
      budget: false,
    });
  });

  it('отметка группы ставит все её события, снятие — снимает; прежний runDone уходит', () => {
    const draft = {
      ...draftOfTelegram(settings({ events: ['runDone', 'permission', 'budget'] }), answers()),
      waits: true,
      broken: true,
      budget: false,
    };
    expect([...notifyBody(draft, true).events].sort()).toEqual(
      ['groupSignal', 'permission', 'question', 'runError', 'testFailed'].sort(),
    );
  });
});

describe('черновик карточки и два тела запроса', () => {
  it('«Агент закончил»: порог 0 — галочка снята, минуты по умолчанию 5', () => {
    expect(draftOfTelegram(settings({ doneAfterMinutes: 0 }), answers())).toMatchObject({
      finished: false,
      doneAfterMinutes: '5',
    });
    const draft = draftOfTelegram(settings({ doneAfterMinutes: 12 }), answers());
    expect(draft).toMatchObject({ finished: true, doneAfterMinutes: '12' });
    expect(notifyBody({ ...draft, finished: false }, true).doneAfterMinutes).toBe(0);
    expect(notifyBody(draft, true).doneAfterMinutes).toBe(12);
  });

  it('кнопки ответа — всегда, когда отмечено «Агент ждёт тебя»: отдельной галочки нет', () => {
    // Ответы были выключены прежней галочкой — «Агент ждёт тебя» их включает.
    const draft = draftOfTelegram(
      settings({ events: ['permission', 'question'] }),
      answers({ enabled: false, afterMinutes: 4 }),
    );
    expect(draft).toMatchObject({ waits: true, afterMinutes: '4' });
    expect(draft).not.toHaveProperty('withButtons');
    expect(answersBody(draft)).toEqual({ enabled: true, afterMinutes: 4, ownerId: '777' });
    expect(answersBody({ ...draft, waits: false }).enabled).toBe(false);
  });

  it('«Убирать отвеченное» убрано: отвеченное сворачивается само, в черновике и теле поля нет', () => {
    const draft = draftOfTelegram(settings(), answers());
    expect(draft).not.toHaveProperty('cleanup');
    expect(draft).not.toHaveProperty('cleanupMinutes');
    expect(answersBody(draft)).not.toHaveProperty('cleanup');
  });
});

describe('подключено ли и что со связью', () => {
  it('подключено — токен есть и чат известен', () => {
    expect(isTelegramConnected(status(), settings())).toBe(true);
    expect(isTelegramConnected(status({ hasToken: false }), settings())).toBe(false);
    expect(isTelegramConnected(status(), settings({ chatId: ' ' }))).toBe(false);
  });

  it('работает, выключено, ошибка проверки, недоставленное, опрос ответов в беде', () => {
    expect(cardHealth({ settings: settings(), status: status() })).toEqual({
      tone: 'ok',
      bot: '@deck_bot',
    });
    expect(cardHealth({ settings: settings({ enabled: false }), status: status() }).tone).toBe(
      'off',
    );
    expect(
      cardHealth({
        settings: settings(),
        status: status({ state: 'error', detail: 'Telegram: токен отклонён (401).' }),
      }),
    ).toEqual({
      tone: 'error',
      reason: { kind: 'check', text: 'Telegram: токен отклонён (401).' },
    });
    expect(
      cardHealth({
        settings: settings(),
        status: status({
          lastSend: { at: '2026-10-25T10:00:00Z', ok: false, error: '403: blocked' },
        }),
      }),
    ).toMatchObject({ reason: { kind: 'send', text: '403: blocked' } });
    expect(
      cardHealth({
        settings: settings(),
        status: status(),
        answers: { settings: answers({ enabled: true }), status: { state: 'webhook' } },
      }),
    ).toMatchObject({ reason: { kind: 'answers', state: 'webhook' } });
  });
});

describe('одно «Сохранить» на две настройки', () => {
  it('сначала уведомления, потом ответы; оба удались — ok', async () => {
    const order: string[] = [];
    const result = await saveTelegramCard({
      saveNotify: vi.fn(async () => void order.push('notify')),
      saveAnswers: vi.fn(async () => void order.push('answers')),
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['notify', 'answers']);
  });

  it('упали уведомления — ответы не трогаются; упали ответы — сказано, что уведомления сохранены', async () => {
    const saveAnswers = vi.fn(async () => undefined);
    const notifyFailed = await saveTelegramCard({
      saveNotify: async () => {
        throw new Error('400');
      },
      saveAnswers,
    });
    expect(notifyFailed).toMatchObject({ ok: false, failed: 'notify' });
    expect(saveAnswers).not.toHaveBeenCalled();
    const answersFailed = await saveTelegramCard({
      saveNotify: async () => undefined,
      saveAnswers: async () => {
        throw new Error('403');
      },
    });
    expect(answersFailed).toMatchObject({ ok: false, failed: 'answers' });
  });
});
