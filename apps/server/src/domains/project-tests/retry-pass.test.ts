import { describe, expect, it } from 'vitest';
import type { ProjectTestPointResult } from '@agentdeck/contracts';
import { retryPassAttempts, resultReason } from '@agentdeck/contracts/test-format';
import { legacyRetryAttempts, parseRetryPass, withLegacyRetry } from './retry-pass.ts';

/**
 * F-355: признак «прошёл только на повторе» — число, а слова даёт сторона.
 * Кейс показывает его, только пока признак относится к последнему результату.
 */
describe('признак повтора у кейса', () => {
  it('виден у зелёного с тем же последним прогоном', () => {
    expect(
      retryPassAttempts({ status: 'passed', lastRunId: 'r1', flaky: { attempts: 2, runId: 'r1' } }),
    ).toBe(2);
  });

  it('прогон мимо импорта его гасит, красный тоже', () => {
    expect(
      retryPassAttempts({ status: 'passed', lastRunId: 'r2', flaky: { attempts: 2, runId: 'r1' } }),
    ).toBeUndefined();
    expect(
      retryPassAttempts({ status: 'failed', lastRunId: 'r1', flaky: { attempts: 2, runId: 'r1' } }),
    ).toBeUndefined();
  });

  it('причина прохода — `flaky` с числом, когда ни разбора, ни заметки', () => {
    expect(resultReason({ flakyAttempts: 3 })).toEqual({ source: 'flaky', text: '', attempts: 3 });
    expect(resultReason({ flakyAttempts: 3, note: 'руками' })?.source).toBe('note');
  });
});

describe('старые записи', () => {
  it('узнаётся только фраза панели целиком', () => {
    expect(
      legacyRetryAttempts('Нестабильный: прошёл только на повторе (упавших попыток: 4).'),
    ).toBe(4);
    expect(legacyRetryAttempts('Нестабильный: прошёл только на повторе.')).toBe(1);
    expect(legacyRetryAttempts('Нестабильный стенд')).toBeUndefined();
    expect(legacyRetryAttempts(undefined)).toBeUndefined();
  });

  it('поле из файла: мусор отбрасывается', () => {
    expect(parseRetryPass({ attempts: 2, runId: 'r' })).toEqual({ attempts: 2, runId: 'r' });
    expect(parseRetryPass({ attempts: 0 })).toBeUndefined();
    expect(parseRetryPass({ attempts: '2' })).toBeUndefined();
    expect(parseRetryPass('x')).toBeUndefined();
  });

  it('не объект в истории идёт как есть, а не роняет чтение', () => {
    expect(withLegacyRetry(null as unknown as ProjectTestPointResult)).toBeNull();
  });
});
