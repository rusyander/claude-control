/**
 * Доля окон лимита подписки на группу (`@agentdeck/contracts` limit-share).
 *
 * Загрузка окна — общая на всю подписку, поэтому «конец − начало» у прогона
 * его долей не является: при параллельных группах каждая насчитала бы себе
 * чужую трату. Тест держит деление прироста по отрезкам между замерами
 * (перекрытие по токенам, без двойного счёта), сброс окна (новое окно — от
 * нуля, никогда не минус), прогон без события (долю на чужих отрезках
 * получает) и трату снаружи панели (никому не достаётся).
 */
import { describe, expect, it } from 'vitest';
import {
  apportionLimitShare,
  sumLimitShares,
  windowDelta,
  type LimitRun,
  type LimitSample,
} from '@agentdeck/contracts';
import { limitShareText } from './limitShareText';

const RESET = 1_800_000_000;

/** Замер обоих окон: пятичасовое — `five`, недельное — вдвое меньше. */
function at(ms: number, five: number, resetsAt = RESET): LimitSample {
  return {
    at: ms,
    fiveHour: { utilization: five, resetsAt },
    sevenDay: { utilization: five / 2, resetsAt: RESET + 500_000 },
  };
}

function run(
  id: string,
  startedAt: number,
  endedAt: number,
  tokens: number,
  samples: LimitSample[],
): LimitRun {
  return { id, startedAt, endedAt, tokens, samples };
}

describe('apportionLimitShare', () => {
  it('один прогон — вся разница его замеров', () => {
    const shares = apportionLimitShare([run('a', 0, 100, 50, [at(0, 0.1), at(100, 0.16)])]);
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.06);
    expect(shares.get('a')?.sevenDay).toBeCloseTo(0.03);
  });

  it('перекрытие: прирост делится по токенам на отрезке, сумма = общий прирост, а не вдвое больше', () => {
    // A: 0–100 мс, 200 токенов; B: 50–150 мс, 100 токенов.
    const shares = apportionLimitShare([
      run('a', 0, 100, 200, [at(0, 0.1), at(100, 0.26)]),
      run('b', 50, 150, 100, [at(50, 0.14), at(150, 0.3)]),
    ]);
    // [0,50] +0.04 → только A; [50,100] +0.12 → A 100 : B 50; [100,150] +0.04 → только B.
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.12);
    expect(shares.get('b')?.fiveHour).toBeCloseTo(0.08);
    const total = (shares.get('a')?.fiveHour ?? 0) + (shares.get('b')?.fiveHour ?? 0);
    expect(total).toBeCloseTo(0.3 - 0.1);
  });

  it('токены прогона размазаны по его длительности: на отрезке — только их часть', () => {
    // A: 0–100 мс, 100 токенов (на [50,100] — 50); B: 50–100 мс, 100 токенов (все на [50,100]).
    const shares = apportionLimitShare([
      run('a', 0, 100, 100, [at(0, 0.1), at(100, 0.22)]),
      run('b', 50, 100, 100, [at(50, 0.13)]),
    ]);
    // [0,50] +0.03 → только A; [50,100] +0.09 → A 50 : B 100.
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.06);
    expect(shares.get('b')?.fiveHour).toBeCloseTo(0.06);
  });

  it('сброс окна между замерами: новое окно считается от нуля, а не минусом', () => {
    const shares = apportionLimitShare([
      run('a', 0, 100, 10, [at(0, 0.8, RESET), at(100, 0.05, RESET + 18_000)]),
    ]);
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.05);
    expect(
      windowDelta({ utilization: 0.8, resetsAt: 1 }, { utilization: 0.05, resetsAt: 2 }),
    ).toBeCloseTo(0.05);
  });

  it('загрузка упала без сброса — прирост ноль, окна у прогона нет', () => {
    const shares = apportionLimitShare([run('a', 0, 100, 10, [at(0, 0.3), at(100, 0.29)])]);
    expect(shares.get('a')?.fiveHour).toBeUndefined();
    expect(windowDelta({ utilization: 0.3, resetsAt: 1 }, { utilization: 0.29, resetsAt: 1 })).toBe(
      0,
    );
  });

  it('прогон без события получает долю на чужих отрезках по своим токенам', () => {
    const shares = apportionLimitShare([
      run('a', 0, 100, 100, [at(0, 0.1), at(100, 0.2)]),
      run('silent', 0, 100, 300, []),
    ]);
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.025);
    expect(shares.get('silent')?.fiveHour).toBeCloseTo(0.075);
  });

  it('прирост, пока в панели ничего не шло, — трата снаружи, никому не достаётся', () => {
    const shares = apportionLimitShare([
      run('a', 0, 100, 10, [at(0, 0.1), at(100, 0.2)]),
      run('b', 200, 300, 10, [at(200, 0.25), at(300, 0.27)]),
    ]);
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.1);
    expect(shares.get('b')?.fiveHour).toBeCloseTo(0.02);
  });

  it('токенов нет ни у кого — прирост делится по времени на отрезке', () => {
    const shares = apportionLimitShare([
      run('a', 0, 100, 0, [at(0, 0.1), at(100, 0.2)]),
      run('b', 50, 100, 0, []),
    ]);
    expect(shares.get('a')?.fiveHour).toBeCloseTo(0.1 * (100 / 150));
    expect(shares.get('b')?.fiveHour).toBeCloseTo(0.1 * (50 / 150));
  });

  it('окна нет в событии — нет и доли по нему', () => {
    const five = (ms: number, value: number): LimitSample => ({
      at: ms,
      fiveHour: { utilization: value, resetsAt: RESET },
    });
    const shares = apportionLimitShare([run('a', 0, 100, 10, [five(0, 0.1), five(100, 0.2)])]);
    expect(shares.get('a')).toEqual({ fiveHour: expect.closeTo(0.1) });
  });
});

describe('sumLimitShares', () => {
  it('складывает окна звеньев; ни у кого нет — undefined, а не нули', () => {
    expect(sumLimitShares([undefined, undefined])).toBeUndefined();
    expect(
      sumLimitShares([{ fiveHour: 0.02 }, undefined, { fiveHour: 0.01, sevenDay: 0.004 }]),
    ).toEqual({
      fiveHour: expect.closeTo(0.03),
      sevenDay: 0.004,
    });
  });
});

describe('limitShareText', () => {
  const dictionary: Record<string, string> = {
    'chat.cascade.hub.meta.limitFiveHour': '5 h: {{value}}',
    'chat.cascade.hub.meta.limitSevenDay': 'week: {{value}}',
  };
  const t = (key: string, options: { value: string }) =>
    (dictionary[key] ?? key).replace('{{value}}', options.value);

  it('оба окна: целые от 10 %, меньше — с десятой', () => {
    expect(limitShareText({ fiveHour: 0.12, sevenDay: 0.015 }, t, 'en')).toBe(
      '5 h: 12%, week: 1.5%',
    );
  });

  it('окно без замеров не пишется; нет ни одного — строки нет', () => {
    expect(limitShareText({ sevenDay: 0.2 }, t, 'en')).toBe('week: 20%');
    expect(limitShareText({}, t, 'en')).toBeUndefined();
    expect(limitShareText(undefined, t, 'en')).toBeUndefined();
  });
});
