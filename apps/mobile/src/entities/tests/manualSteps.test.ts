import { describe, expect, it } from 'vitest';
import { manualSteps } from './manualSteps';
import { restoreStepStatuses } from './restoreStepStatuses';

describe('manualSteps', () => {
  const shared = [
    {
      id: 'login',
      steps: [
        { action: 'Open site', expected: 'Home' },
        { action: 'Enter creds', expected: 'Logged in' },
      ],
    },
  ];

  it('общий шаг раскрыт: номер шага после ссылки совпадает с тем, что считает сервер', () => {
    const steps = manualSteps(
      [
        { action: 'Login', ref: 'login' },
        { action: 'Open cart', expected: 'Cart shows 3 items' },
      ],
      shared,
    );
    const at = steps.findIndex((step) => step.action === 'Open cart');
    // Сервер (`expectedOf`) берёт ожидание из раскрытого списка по этому номеру.
    expect(at).toBe(2);
    expect(steps[at]?.expected).toBe('Cart shows 3 items');
  });

  it('параметры прохода подставлены, неизвестная ссылка остаётся подписью', () => {
    expect(
      manualSteps([{ action: 'войти как %role', expected: '%role в шапке' }], [], {
        role: 'admin',
      }),
    ).toEqual([{ action: 'войти как admin', expected: 'admin в шапке' }]);
    expect(manualSteps([{ action: 'подпись', ref: 'нет-такого' }], shared)).toEqual([
      { action: 'подпись' },
    ]);
  });
});

describe('restoreStepStatuses', () => {
  it('отметка третьего шага возвращается на третий, а не на первый', () => {
    expect(restoreStepStatuses(3, [{ index: 2, status: 'failed' }])).toEqual([
      'unknown',
      'unknown',
      'failed',
    ]);
  });

  it('без записи — все шаги не проверены; отметка за пределами списка игнорируется', () => {
    expect(restoreStepStatuses(2, undefined)).toEqual(['unknown', 'unknown']);
    expect(restoreStepStatuses(1, [{ index: 5, status: 'passed' }])).toEqual(['unknown']);
  });
});
