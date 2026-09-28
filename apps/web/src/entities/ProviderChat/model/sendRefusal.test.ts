import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { isAnswerRunningRefusal } from './sendRefusal';

const refusal = (status: number): AxiosError =>
  new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { messageCode: 'foreign-answer-running' },
  });

/** F-370: отказ 409 «ответ ещё идёт» не гасит индикатор живого хода. */
describe('isAnswerRunningRefusal', () => {
  it('409 отправки — ход жив', () => {
    expect(isAnswerRunningRefusal(refusal(409))).toBe(true);
  });

  it('404, 500 и обрыв сети — ход не начался', () => {
    expect(isAnswerRunningRefusal(refusal(404))).toBe(false);
    expect(isAnswerRunningRefusal(refusal(500))).toBe(false);
    expect(isAnswerRunningRefusal(new Error('network'))).toBe(false);
  });
});
