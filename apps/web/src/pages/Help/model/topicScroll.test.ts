import { describe, it, expect } from 'vitest';
import { anchorOf, isHistoryMove, scrollIntent } from './topicScroll';

/**
 * Кейс help-003: «Следующий раздел» открывал новый документ на высоте прошлого
 * (9232px). Решение о прокрутке — чистая функция адреса, типа перехода и
 * запомненной позиции записи.
 */
describe('scrollIntent — куда встать при смене документа справки', () => {
  it('новая ссылка — в начало, даже если у записи что-то запомнено', () => {
    expect(scrollIntent({ hash: '', action: 'PUSH', saved: 9232 })).toEqual({ kind: 'top' });
    expect(scrollIntent({ hash: '', action: 'REPLACE', saved: 9232 })).toEqual({ kind: 'top' });
    expect(scrollIntent({ hash: '', action: undefined, saved: 9232 })).toEqual({ kind: 'top' });
  });

  it('«Назад» и «Вперёд» возвращают позицию записи', () => {
    expect(scrollIntent({ hash: '', action: 'BACK', saved: 9232 })).toEqual({
      kind: 'restore',
      top: 9232,
    });
    expect(scrollIntent({ hash: '', action: 'FORWARD', saved: 0 })).toEqual({
      kind: 'restore',
      top: 0,
    });
    expect(scrollIntent({ hash: '', action: 'GO', saved: 40 })).toEqual({
      kind: 'restore',
      top: 40,
    });
  });

  it('«Назад» к записи без позиции — в начало', () => {
    expect(scrollIntent({ hash: '', action: 'BACK', saved: undefined })).toEqual({ kind: 'top' });
  });

  it('якорь в адресе сильнее и сброса, и возврата', () => {
    expect(scrollIntent({ hash: '#limits', action: 'PUSH', saved: 0 })).toEqual({
      kind: 'anchor',
      id: 'limits',
    });
    expect(scrollIntent({ hash: 'limits', action: 'BACK', saved: 500 })).toEqual({
      kind: 'anchor',
      id: 'limits',
    });
  });
});

describe('anchorOf', () => {
  it('раскодирует якорь и не падает на битой последовательности', () => {
    expect(anchorOf('#%D0%BF%D1%80%D0%B0%D0%B2%D0%B0')).toBe('права');
    expect(anchorOf('#%E0%A4')).toBe('');
    expect(anchorOf('#')).toBe('');
    expect(anchorOf('')).toBe('');
  });
});

describe('isHistoryMove', () => {
  it('только переходы по истории', () => {
    expect(['BACK', 'FORWARD', 'GO'].every((a) => isHistoryMove(a as never))).toBe(true);
    expect(['PUSH', 'REPLACE', undefined].some((a) => isHistoryMove(a as never))).toBe(false);
  });
});
