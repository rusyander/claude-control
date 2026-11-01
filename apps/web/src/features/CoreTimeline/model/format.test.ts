import { describe, expect, it } from 'vitest';
import { verdictLine } from './format';

/**
 * Вердикт записи проверки — объект ядра (`{kind, reason?}`), а не строка: строкой в шаблон он
 * попадал как «[object Object]». На экран идёт вид и причина словами ядра.
 */
describe('verdictLine', () => {
  it('pass — один вид', () => {
    expect(verdictLine({ kind: 'pass' })).toBe('pass');
  });

  it('fail и no-verdict — вид с причиной', () => {
    expect(verdictLine({ kind: 'fail', reason: 'red' })).toBe('fail: red');
    expect(verdictLine({ kind: 'no-verdict', reason: 'stand' })).toBe('no-verdict: stand');
  });

  it('pass-flaky — с числом перезапусков', () => {
    expect(verdictLine({ kind: 'pass-flaky', retries: ['r1.0', 'r1.1'] })).toBe('pass-flaky (2)');
  });
});
