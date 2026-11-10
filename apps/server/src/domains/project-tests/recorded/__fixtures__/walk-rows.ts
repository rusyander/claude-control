import type { BrowseGap, BrowseStep } from '@agentdeck/contracts/core/browse';

/**
 * Строки прохода «вход на стенд» — такие, какие ядро пишет в журнал (`browse.step` / `browse.gap`):
 * открыть вход, ввести почту, ввести пароль доступом стенда, нажать «Войти», увидеть приветствие и
 * адрес. Плюс шум, который в спек идти не должен: снимок страницы, шаг, не прошедший при записи,
 * и пробел (наведение) — он ложится в кейс «не проверено».
 */

const CHECKS = { console: 0, failed: 0, blank: false, stale: false };

/** uuidv7 с растущим хвостом: порядок id = порядок записи. */
export function walkId(n: number): string {
  return `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export const WALK_SECRET = 'STAND_PASSWORD';

export function walkRows(origin: string): { steps: BrowseStep[]; gaps: BrowseGap[] } {
  const step = (n: number, rest: Omit<BrowseStep, 'stepId' | 'n' | 'checks'>): BrowseStep => ({
    stepId: walkId(n * 10),
    n,
    checks: CHECKS,
    ...rest,
  });
  return {
    steps: [
      step(1, { action: 'open', value: `${origin}/login`, url: `${origin}/login`, ok: true }),
      step(2, { action: 'snapshot', url: `${origin}/login`, ok: true }),
      step(3, {
        action: 'fill',
        target: { label: 'Почта' },
        value: 'demo@example.com',
        url: `${origin}/login`,
        ok: true,
      }),
      step(4, {
        action: 'fill',
        target: { label: 'Пароль' },
        secret: { name: WALK_SECRET },
        url: `${origin}/login`,
        ok: true,
      }),
      step(5, {
        action: 'click',
        target: { role: 'link', name: 'Забыли пароль?' },
        url: `${origin}/login`,
        problems: ['element not found'],
        ok: false,
      }),
      step(6, {
        action: 'click',
        target: { role: 'button', name: 'Войти' },
        url: `${origin}/home`,
        ok: true,
      }),
      step(8, {
        action: 'expect',
        expect: 'text',
        target: { testId: 'greeting' },
        value: 'Привет, demo',
        url: `${origin}/home`,
        ok: true,
      }),
      step(9, {
        action: 'expect',
        expect: 'url',
        value: `${origin}/home`,
        url: `${origin}/home`,
        ok: true,
      }),
    ],
    gaps: [
      {
        stepId: walkId(70),
        action: 'hover',
        target: { role: 'button', name: 'Меню' },
        why: 'подменю открывается только наведением',
      },
    ],
  };
}
