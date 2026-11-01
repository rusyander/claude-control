import { describe, expect, it } from 'vitest';
import { failureOf, failureReason } from './failure';

/**
 * Один разбор отказа ядра на все экраны: причина — словами ядра или прокладки, а не «Request
 * failed»; код ответа виден у каждого вида (лента и отчёт сверяют его с кодом ядра).
 */

const axiosError = (status: number | undefined, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

describe('причина отказа команды', () => {
  it('исход ядра {code, reason} — код и причина', () => {
    const error = axiosError(undefined, {
      code: 'signature-required',
      reason: 'peer untrusted-forward',
    });
    expect(failureReason(failureOf(error))).toBe('signature-required: peer untrusted-forward');
  });

  it('тело прокладки {error} — дословно', () => {
    const error = Object.assign(new Error('x'), { response: { data: { error: 'core-absent' } } });
    expect(failureReason(failureOf(error))).toBe('core-absent');
  });

  it('без тела — сообщение ошибки', () => {
    expect(failureReason(failureOf(new Error('Network Error')))).toBe('Network Error');
  });
});

describe('core failure keeps the response status for every kind', () => {
  it('501 of a stage-9 read, a proxy refusal, an authority refusal and a lost response', () => {
    expect(failureOf(axiosError(501, { error: 'not served yet' }))).toEqual({
      kind: 'other',
      status: 501,
      code: '',
      message: 'not served yet',
    });
    expect(failureOf(axiosError(503, { code: 'core-absent' }))).toEqual({
      kind: 'refusal',
      status: 503,
      code: 'core-absent',
    });
    const authority = failureOf(axiosError(403, { code: 'signature-required', error: 'peer' }));
    expect(authority.status).toBe(403);
    expect(failureReason(authority)).toBe('signature-required: peer');
    expect(failureOf(new Error('Network Error'))).toEqual({
      kind: 'network',
      status: null,
      message: 'Network Error',
    });
  });
});
