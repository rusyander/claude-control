import { describe, expect, it } from 'vitest';
import { failureOf } from './refusalOf';
import { gateOf, intOf, linesOf, listOf } from './fields';

describe('scenario step fields: text to schema values', () => {
  it('lists drop empty pieces, lines drop blank lines', () => {
    expect(listOf(' a, b ,, c ,')).toEqual(['a', 'b', 'c']);
    expect(listOf('')).toEqual([]);
    expect(linesOf('Да\n\n  Нет  \n')).toEqual(['Да', 'Нет']);
  });

  it('an empty number is no limit, garbage is NaN so the schema names the field', () => {
    expect(intOf('')).toBeUndefined();
    expect(intOf(' 120 ')).toBe(120);
    expect(intOf('12k')).toBeNaN();
    expect(intOf('-3')).toBeNaN();
  });

  it('a gate of a new kind carries exactly the fields that kind requires', () => {
    expect(gateOf('check-green')).toEqual({ kind: 'check-green', checkId: '' });
    expect(gateOf('text')).toEqual({ kind: 'text', criterion: '' });
    expect(gateOf('review-no-blocking')).toEqual({ kind: 'review-no-blocking' });
  });

  it('a failure without a core body still answers the button', () => {
    expect(failureOf(new Error('Network Error'))).toMatchObject({
      code: 'request-failed',
      reason: 'Network Error',
    });
    expect(
      failureOf({
        response: { status: 409, data: { code: 'version-taken', error: 'x', next: 3 } },
      }),
    ).toMatchObject({ code: 'version-taken', next: 3, status: 409 });
  });
});
