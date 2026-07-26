import { describe, it, expect } from 'vitest';
import { ru } from '@shared/config/i18n/ru';
import { en } from '@shared/config/i18n/en';
import { isReportableSpeechError, nextStateAfterEnd, speechErrorMessageKey } from './speech-state';
import type { SpeechErrorKind } from './speech-provider';

/**
 * Регрессия: отказ микрофона не доходил до человека. onError ставил 'error', но
 * браузер следом ВСЕГДА шлёт end, и обработчик безусловно возвращал 'idle' —
 * голосовой режим открывался и молча закрывался.
 */
describe('nextStateAfterEnd', () => {
  it('после ошибки конец сессии НЕ затирает её на idle', () => {
    expect(nextStateAfterEnd('error', false)).toBe('error');
  });

  it('обычное завершение записи возвращает в покой', () => {
    expect(nextStateAfterEnd('listening', false)).toBe('idle');
    expect(nextStateAfterEnd('finalizing', false)).toBe('idle');
  });

  it('пауза в диктовке: слушаем дальше, сессия перезапускается', () => {
    expect(nextStateAfterEnd('listening', true)).toBe('listening');
  });
});

describe('о каких ошибках говорим', () => {
  it('нет доступа, нет сети, нет поддержки — объясняем', () => {
    const kinds: SpeechErrorKind[] = ['no-permission', 'network', 'unsupported'];
    expect(kinds.filter(isReportableSpeechError)).toEqual(kinds);
  });

  it('тишина и отмена — обычный ход диктовки, молчим', () => {
    expect(isReportableSpeechError('no-speech')).toBe(false);
    expect(isReportableSpeechError('aborted')).toBe(false);
    expect(speechErrorMessageKey('aborted')).toBeNull();
    expect(speechErrorMessageKey(null)).toBeNull();
  });

  it('каждый ключ сообщения есть в обоих словарях (иначе в UI вылезет сам ключ)', () => {
    const kinds: SpeechErrorKind[] = [
      'no-permission',
      'no-speech',
      'network',
      'aborted',
      'unsupported',
    ];
    const keys = kinds.map(speechErrorMessageKey).filter((key): key is string => key !== null);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(lookup(ru, key), `ru: ${key}`).toBeTypeOf('string');
      expect(lookup(en, key), `en: ${key}`).toBeTypeOf('string');
    }
  });
});

const lookup = (dictionary: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, dictionary);
