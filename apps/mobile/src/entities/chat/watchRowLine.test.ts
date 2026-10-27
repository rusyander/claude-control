import { describe, expect, it } from 'vitest';
import type { ChatWatchSignalsResponse, GroupSignal } from '@agentdeck/contracts/group-watch';
import { en } from '../../shared/config/i18n/en';
import { ru } from '../../shared/config/i18n/ru';
import { fill, watchRowLine, watchRowText } from './watchRowLine';

/** Строка сторожа в списке чатов телефона (F7): что горит у группы или одиночного чата. */
const signal = (over: Partial<GroupSignal>): GroupSignal => ({
  id: 's',
  rule: 'R4',
  severity: 'warn',
  groupIndex: 0,
  chatId: 'g-chat',
  at: '2026-10-27T10:00:00.000Z',
  numbers: { runs: 3 },
  textKey: 'groupWatch.rule.R4',
  ...over,
});

describe('watchRowLine', () => {
  it('нет ответа или под строкой только заметки — строки нет', () => {
    expect(watchRowLine(undefined, ['a'])).toBeUndefined();
    const view: ChatWatchSignalsResponse = {
      signals: { a: [signal({ severity: 'info', rule: 'R44' })] },
    };
    expect(watchRowLine(view, ['a'])).toBeUndefined();
  });

  it('тревога важнее внимания, при равной важности — свежий; закрытые не считаются', () => {
    const warnNew = signal({ id: 'w2', at: '2026-10-27T11:00:00.000Z' });
    const warnOld = signal({ id: 'w1' });
    const alert = signal({
      id: 'a',
      severity: 'alert',
      rule: 'R10',
      at: '2026-10-27T09:00:00.000Z',
    });
    const cleared = signal({ id: 'c', severity: 'alert', clearedAt: '2026-10-27T12:00:00.000Z' });
    const line = watchRowLine(
      { signals: { a: [warnOld, warnNew, cleared] }, groups: { a: [alert] } },
      ['a'],
    );
    expect(line).toEqual({ count: 3, top: alert });
    const warnsOnly = watchRowLine({ signals: { a: [warnOld, warnNew] } }, ['a']);
    expect(warnsOnly?.top).toBe(warnNew);
  });

  it('сигнал группы под двумя ключами строки (сессия и new-…) считается раз', () => {
    const live = signal({ id: 'x' });
    const line = watchRowLine({ signals: {}, groups: { sess: [live], 'new-1': [live] } }, [
      'sess',
      'new-1',
      undefined,
    ]);
    expect(line?.count).toBe(1);
  });
});

describe('watchRowText', () => {
  it('важность, текст правила с числами и «+N» за остальными — на языке словаря', () => {
    const top = signal({});
    expect(watchRowText({ count: 1, top }, ru)).toBe(
      `внимание: ${ru.groupWatch.rule.R4.replace('{{runs}}', '3')}`,
    );
    expect(watchRowText({ count: 2, top }, ru)).toMatch(/ · \+1$/);
    expect(watchRowText({ count: 3, top }, en)).toBe(
      `${en.groupWatch.severity.warn}: ${en.groupWatch.rule.R4.replace('{{runs}}', '3')} · +2`,
    );
  });

  it('ключа нет в словаре (сервер новее) — имя правила вместо текста', () => {
    const top = signal({ rule: 'R99' as GroupSignal['rule'], textKey: 'groupWatch.rule.R99' });
    expect(watchRowText({ count: 1, top }, ru)).toBe('внимание: R99');
  });

  it('fill: подставляет числа и строки, пропуск — «?»', () => {
    expect(fill('{{a}} из {{ b }}, {{c}}', { a: 1, b: 'x' })).toBe('1 из x, ?');
  });
});
