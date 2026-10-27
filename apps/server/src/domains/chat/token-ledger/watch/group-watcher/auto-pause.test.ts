import { describe, expect, it } from 'vitest';
import type { GroupSignal } from '@agentdeck/contracts/group-watch';
import { AUTO_PAUSE_RULES, autoPauseRule } from './auto-pause.ts';
import { unresumedPause, WATCH_PAUSE_FACTOR } from './pause-rules.ts';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';

/**
 * Пауза сторожа (F1, 27.10): какое правило ставит группе паузу на конце хода и
 * когда о стоящей группе напоминает R43. Решения — чистые функции; их входы —
 * сигналы группы в том виде, как их хранит сторож, и запись группы конвейера.
 */

const ON = { enabled: true, autoPause: true };

function signal(rule: GroupSignal['rule'], extra: Partial<GroupSignal> = {}): GroupSignal {
  return {
    id: `${rule}-1`,
    rule,
    severity: 'warn',
    groupIndex: 0,
    chatId: 'chat-0',
    at: '2026-10-27T10:00:00.000Z',
    numbers: {},
    textKey: `groupWatch.rule.${rule}`,
    ...extra,
  } as GroupSignal;
}

describe('autoPauseRule: какое правило держит группу', () => {
  it('выключено — паузы нет, даже при горящем R4', () => {
    expect(autoPauseRule({ enabled: true, autoPause: false }, [signal('R4')])).toBeUndefined();
    expect(autoPauseRule({ enabled: false, autoPause: true }, [signal('R4')])).toBeUndefined();
  });

  it('горит правило траты по кругу — оно и названо', () => {
    expect(autoPauseRule(ON, [signal('R12')])).toBe('R12');
  });

  it('правило вне набора (R9 окно аккаунта, R1 простой) и закрытый сигнал — паузы нет', () => {
    expect(AUTO_PAUSE_RULES.has('R9')).toBe(false);
    expect(
      autoPauseRule(ON, [
        signal('R9', { severity: 'alert' }),
        signal('R1'),
        signal('R4', { clearedAt: '2026-10-27T10:05:00.000Z' }),
      ]),
    ).toBeUndefined();
  });

  it('из нескольких — самое важное, при равной важности — раньше сработавшее', () => {
    expect(
      autoPauseRule(ON, [
        signal('R4', { severity: 'warn', at: '2026-10-27T09:00:00.000Z' }),
        signal('R8', { severity: 'alert', at: '2026-10-27T10:00:00.000Z' }),
      ]),
    ).toBe('R8');
    expect(
      autoPauseRule(ON, [
        signal('R21', { at: '2026-10-27T10:00:00.000Z' }),
        signal('R24', { at: '2026-10-27T09:30:00.000Z' }),
        signal('R41', { at: '2026-10-27T09:45:00.000Z' }),
      ]),
    ).toBe('R24');
  });
});

const PAUSED_AT = Date.parse('2026-10-27T09:00:00.000Z');
const MIN = 60_000;

function paused(extra: Partial<SplitPlanGroupRecord> = {}): SplitPlanGroupRecord {
  return {
    index: 0,
    title: 'Раз',
    branch: 'feature/one',
    status: 'paused',
    pausedAt: new Date(PAUSED_AT).toISOString(),
    ...extra,
  } as SplitPlanGroupRecord;
}

describe('unresumedPause (R43): стоящая группа, где человеку решать нечего', () => {
  const settings = { unresumedMinutes: 60 };

  it('пауза человека — напоминание после часа, не раньше', () => {
    expect(unresumedPause(paused(), settings, PAUSED_AT + 59 * MIN, false)).toBeUndefined();
    expect(unresumedPause(paused(), settings, PAUSED_AT + 60 * MIN, false)).toMatchObject({
      rule: 'R43',
      severity: 'info',
      numbers: { pausedMin: 60 },
      textKey: 'groupWatch.rule.R43',
    });
  });

  it('пауза сторожа — вчетверо раньше, с правилом в тексте', () => {
    expect(WATCH_PAUSE_FACTOR).toBe(4);
    const group = paused({ pausedBy: 'watch', pausedRule: 'R4' });
    expect(unresumedPause(group, settings, PAUSED_AT + 14 * MIN, false)).toBeUndefined();
    expect(unresumedPause(group, settings, PAUSED_AT + 15 * MIN, false)).toMatchObject({
      rule: 'R43',
      params: { rule: 'R4' },
      textKey: 'groupWatch.rule.R43watch',
    });
  });

  it('пауза на вопросе человека или ждущий D-n — молчит', () => {
    const late = PAUSED_AT + 300 * MIN;
    expect(unresumedPause(paused({ pausedWait: 'question' }), settings, late, false)).toBe(
      undefined,
    );
    expect(unresumedPause(paused(), settings, late, true)).toBeUndefined();
  });

  it('группа не на паузе или без времени паузы — молчит', () => {
    const late = PAUSED_AT + 300 * MIN;
    expect(unresumedPause(paused({ status: 'started' }), settings, late, false)).toBe(undefined);
    expect(unresumedPause(paused({ pausedAt: undefined }), settings, late, false)).toBe(undefined);
  });
});
