import { describe, expect, it } from 'vitest';
import type { TelegramAnswersStatus } from '@agentdeck/contracts/telegram-answers';
import { answersDetail, showsAnswersToken } from './telegramAnswersView';

/** Один бот по умолчанию: поле второго токена — только когда без него никак. */
describe('блок ответов из Telegram', () => {
  const status = (state: TelegramAnswersStatus['state'], detail?: string) => ({
    state,
    ...(detail ? { detail } : {}),
  });

  it('поле отдельного токена — при same-bot или когда токен уже сохранён', () => {
    expect(showsAnswersToken({ hasToken: false, status: status('polling') })).toBe(false);
    expect(showsAnswersToken({ hasToken: false, status: status('off') })).toBe(false);
    expect(showsAnswersToken({ hasToken: false, status: status('same-bot') })).toBe(true);
    expect(showsAnswersToken({ hasToken: true, status: status('polling') })).toBe(true);
  });

  it('подробность видна у любого состояния, где она есть, и у «слушаю» с отказом отправки', () => {
    expect(answersDetail(status('polling'))).toBeUndefined();
    expect(answersDetail(status('polling', 'не удалось написать владельцу: 403'))).toBe(
      'не удалось написать владельцу: 403',
    );
    expect(answersDetail(status('webhook', 'у бота стоит вебхук'))).toBe('у бота стоит вебхук');
    expect(answersDetail(status('off', 'файл ответов был повреждён'))).toBe(
      'файл ответов был повреждён',
    );
  });
});
