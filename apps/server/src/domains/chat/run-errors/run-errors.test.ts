import { describe, expect, it } from 'vitest';
import { isRetriableRunError, runErrorCode } from './run-errors.ts';

/**
 * Коды известных ошибок CLI. Текст — дословно из живого прогона 25.09.2026:
 * родитель разделения переполнился, а сжатие упало, потому что панель
 * запускала устаревший CLI.
 */
const LIVE =
  'Prompt is too long · automatic compaction failed: API Error: 400 Claude Code 2.1.278 does not ' +
  "support this model; version 2.1.280 or newer is required. Run 'claude update', or update the " +
  'Claude desktop app, then try again.';

describe('runErrorCode', () => {
  it('устаревший CLI главнее переполнения: версии в параметрах, переполнение — флагом', () => {
    expect(runErrorCode(LIVE)).toEqual({
      code: 'cli-outdated',
      params: { current: '2.1.278', required: '2.1.280' },
      overflow: true,
    });
  });

  it('устаревший CLI без переполнения — без флага', () => {
    const text = LIVE.replace('Prompt is too long · automatic compaction failed: ', '');
    expect(runErrorCode(text)).toEqual({
      code: 'cli-outdated',
      params: { current: '2.1.278', required: '2.1.280' },
    });
  });

  it('просто переполненный контекст', () => {
    expect(runErrorCode('Prompt is too long')).toEqual({ code: 'prompt-too-long', overflow: true });
  });

  it('чужая ошибка — без кода, и временной она от этого не становится', () => {
    expect(runErrorCode('claude завершился с кодом 1')).toBeUndefined();
    expect(isRetriableRunError(LIVE)).toBe(false);
  });
});
