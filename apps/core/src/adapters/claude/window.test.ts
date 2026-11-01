import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeWindow } from './window.ts';

/**
 * Строка окна Claude (`rate_limit_event`, схема CLI 2.1.286 — та же, что разбирает панель
 * `domains/chat/chat-events.ts`): доля самого тесного окна, сброс, предупреждение ≠ отказ (P19).
 */

const at = (info: object) => ({ type: 'rate_limit_event', rate_limit_info: info });

describe('claude window event (rate_limit_event → WindowObservation)', () => {
  it('recorded line of CLI 2.1.177 (no unifiedWindows): allowed, no share — open fact, not a refusal', () => {
    const raw = readFileSync(
      join(
        import.meta.dirname,
        '../../../../server/src/domains/chat/__fixtures__/stream-json-2.1.177.jsonl',
      ),
      'utf8',
    );
    const line = raw.split('\n').find((l) => l.includes('"rate_limit_event"'))!;
    expect(readClaudeWindow(JSON.parse(line) as Record<string, unknown>)).toEqual({
      limitKind: 'window',
      usedPct: null,
      resetAt: 1_788_351_600_000,
      warning: false,
      refusal: false,
      window: 'five_hour',
    });
  });

  it('2.1.286 schema: the tightest unified window gives share and reset; allowed_warning is a warning', () => {
    expect(
      readClaudeWindow(
        at({
          status: 'allowed_warning',
          resetsAt: 50,
          rateLimitType: 'five_hour',
          unifiedWindows: {
            five_hour: { utilization: 0.42, resetsAt: 50 },
            seven_day: { utilization: 0.915, resetsAt: 900 },
          },
        }),
      ),
    ).toEqual({
      limitKind: 'window',
      usedPct: 91.5,
      resetAt: 900_000,
      warning: true,
      refusal: false,
      window: 'seven_day',
    });
  });

  it('rejected is a refusal: reset and name are the refusing window, not the fullest one', () => {
    expect(
      readClaudeWindow(
        at({
          status: 'rejected',
          resetsAt: 70,
          rateLimitType: 'five_hour',
          unifiedWindows: { seven_day: { utilization: 0.99, resetsAt: 900 } },
        }),
      ),
    ).toMatchObject({ refusal: true, warning: false, resetAt: 70_000, window: 'five_hour' });
  });

  it('a direct utilization above every unified one wins; garbage shares are ignored', () => {
    expect(
      readClaudeWindow(
        at({
          status: 'allowed',
          utilization: 0.97,
          resetsAt: 5,
          rateLimitType: 'seven_day_opus',
          unifiedWindows: {
            five_hour: { utilization: 0.5, resetsAt: 9 },
            bad: { utilization: 'x' },
          },
        }),
      ),
    ).toMatchObject({ usedPct: 97, resetAt: 5_000, window: 'seven_day_opus' });
    expect(readClaudeWindow(at({ status: 'allowed', utilization: 42 }))).toMatchObject({
      usedPct: null,
      resetAt: null,
    });
  });

  it('other lines and a window line without info are not window facts', () => {
    expect(readClaudeWindow({ type: 'system' })).toBeUndefined();
    expect(readClaudeWindow({ type: 'rate_limit_event' })).toBeUndefined();
  });
});
