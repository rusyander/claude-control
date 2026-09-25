import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { focusPlanCancel, isPlanRunningRefusal } from './planCancelOffer';

/**
 * Отказ 409 «разделение уже идёт» узнаётся по коду сервера, а не по тексту, и
 * предложение ведёт к кнопке хаба (W3-5).
 */
function refusal(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  });
}

describe('отказ «план идёт»', () => {
  it('409 с кодом split-plan-running — наш', () => {
    expect(isPlanRunningRefusal(refusal(409, { messageCode: 'split-plan-running' }))).toBe(true);
  });

  it('другой код, другой статус, не axios — не наш', () => {
    expect(isPlanRunningRefusal(refusal(409, { messageCode: 'run-busy' }))).toBe(false);
    expect(isPlanRunningRefusal(refusal(400, { messageCode: 'split-plan-running' }))).toBe(false);
    expect(isPlanRunningRefusal(new Error('split-plan-running'))).toBe(false);
  });
});

describe('переход к кнопке «Отменить план»', () => {
  it('прокручивает к кнопке и ставит на неё фокус', () => {
    const button = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const root = { querySelector: vi.fn(() => button) } as unknown as ParentNode;

    expect(focusPlanCancel(root)).toBe(true);
    expect(root.querySelector).toHaveBeenCalledWith('[data-plan-cancel]');
    expect(button.scrollIntoView).toHaveBeenCalled();
    expect(button.focus).toHaveBeenCalled();
  });

  it('хаба нет на экране — false, без падения', () => {
    const root = { querySelector: () => null } as unknown as ParentNode;
    expect(focusPlanCancel(root)).toBe(false);
  });
});
