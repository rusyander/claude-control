import { describe, expect, it } from 'vitest';
import type { WatcherStatus } from '@agentdeck/contracts';
import { watcherEn } from '../../shared/config/i18n/watcher/en';
import { watcherRu } from '../../shared/config/i18n/watcher/ru';
import { formatUptime, watcherElapsedMs, watcherSpendText, watcherVisible } from './model';

/**
 * Значок наблюдателя на главной телефона: виден ли, сколько работает и сколько
 * потратил — ровно то, что человек читает с экрана.
 */
const status = (over: Partial<WatcherStatus> = {}): WatcherStatus => ({
  enabled: true,
  since: '2026-09-27T10:00:00.000Z',
  serverNow: '2026-09-27T10:12:04.000Z',
  analyzing: false,
  pending: 0,
  findings: 0,
  remarks: 0,
  thresholds: { slowRequestMs: 3000, stuckLoadingMs: 15000 },
  hourlyCap: { limit: 6, used: 1 },
  spend: { input: 1000, output: 200, cacheRead: 5000, cacheCreation: 300, runs: 1 },
  reportPath: 'C:/Users/me/.agentdeck/watcher/report.md',
  ...over,
});
const RU = watcherRu.duration;

describe('watcherVisible — значок только у включённого', () => {
  it('включён — виден; выключен или ответа нет — нет', () => {
    expect(watcherVisible(status())).toBe(true);
    expect(watcherVisible(status({ enabled: false }))).toBe(false);
    expect(watcherVisible(undefined)).toBe(false);
  });
});

describe('watcherElapsedMs — по часам сервера, а не телефона', () => {
  it('часы телефона отстают на час — время работы то же', () => {
    const phoneBehind = Date.parse('2026-09-27T09:00:00.000Z');
    expect(watcherElapsedMs(status(), phoneBehind, phoneBehind + 5_000)).toBe(
      12 * 60_000 + 4_000 + 5_000,
    );
  });
  it('без отметки включения или с битой датой — ноль, а не NaN', () => {
    expect(watcherElapsedMs(status({ since: undefined }), 0, 10)).toBe(0);
    expect(watcherElapsedMs(status({ since: 'не дата' }), 0, 10)).toBe(0);
  });
});

describe('formatUptime — как в панели', () => {
  it('секунды, минуты с секундами, часы с минутами', () => {
    expect(formatUptime(4_000, RU)).toBe('4с');
    expect(formatUptime(72_000, RU)).toBe('1м 12с');
    expect(formatUptime(3_780_000, RU)).toBe('1ч 03м');
    expect(formatUptime(-5, RU)).toBe('0с');
    expect(formatUptime(72_000, watcherEn.duration)).toBe('1m 12s');
  });
});

describe('watcherSpendText — единицы из панели, деньги только оценкой', () => {
  it('токены по умолчанию; деньги — с пометкой оценки; без прайса — токены', () => {
    expect(watcherSpendText(status().spend, 'tokens')).toEqual({
      text: '6.5k tok',
      estimate: false,
    });
    expect(watcherSpendText({ ...status().spend, estimatedUsd: 0.0421 }, 'money')).toEqual({
      text: '$0.042',
      estimate: true,
    });
    expect(watcherSpendText(status().spend, 'money')).toEqual({
      text: '6.5k tok',
      estimate: false,
    });
  });
});

describe('тексты сводки', () => {
  it('русские формы по числу', () => {
    expect(watcherRu.findings(1, 0)).toBe('В отчёте 1 раздел');
    expect(watcherRu.findings(3, 2)).toBe('В отчёте 3 раздела, из них 2 замечания');
    expect(watcherRu.findings(11, 5)).toBe('В отчёте 11 разделов, из них 5 замечаний');
    expect(watcherRu.pending(21)).toBe('Ждут разбора: 21 проблема');
  });
  it('у каждой причины сбоя есть текст на обоих языках', () => {
    for (const code of [
      'cli_missing',
      'report_unwritable',
      'analysis_failed',
      'hourly_cap',
    ] as const) {
      expect(watcherRu.problem[code]).toBeTruthy();
      expect(watcherEn.problem[code]).toBeTruthy();
    }
  });
});
