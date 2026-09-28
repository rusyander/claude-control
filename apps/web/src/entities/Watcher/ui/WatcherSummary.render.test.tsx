import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WatcherStatus } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { WatcherSummary } from './WatcherSummary';

const base: WatcherStatus = {
  enabled: true,
  since: '2026-09-27T10:00:00.000Z',
  serverNow: '2026-09-27T10:01:12.000Z',
  analyzing: false,
  pending: 0,
  findings: 3,
  remarks: 0,
  thresholds: { slowRequestMs: 5000, stuckLoadingMs: 30_000 },
  hourlyCap: { limit: 12, used: 1 },
  spend: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, runs: 1, estimatedUsd: 0.01 },
  reportPath: 'C:/app/WATCH-REPORT.md',
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('сводка наблюдателя', () => {
  it('время, расход в токенах и находки; подписи «оценка» в токенах нет', () => {
    const html = renderToStaticMarkup(
      <WatcherSummary status={base} elapsed={72_000} costUnit="tokens" />,
    );
    expect(html).toContain(i18n.t('watcher.running', { time: '1м 12с' }));
    expect(html).toContain('1.0k tok');
    expect(html).toContain(i18n.t('watcher.findings', { count: 3 }));
    expect(html).not.toContain(i18n.t('watcher.spendEstimate'));
    expect(html).not.toContain('WATCH-REPORT.md');
    // Замечаний нет — и слова о них нет.
    expect(html).not.toContain(i18n.t('watcher.remarks', { count: 0 }));
  });

  it('замечания модели — отдельным числом; потолок в час — словами', () => {
    const html = renderToStaticMarkup(
      <WatcherSummary
        status={{
          ...base,
          remarks: 2,
          problem: { problemCode: 'hourly_cap', message: 'server text', at: base.serverNow },
        }}
        elapsed={0}
        costUnit="tokens"
      />,
    );
    expect(html).toContain(i18n.t('watcher.remarks', { count: 2 }));
    expect(html).toContain('data-watcher-problem="hourly_cap"');
    expect(html).toContain(i18n.t('watcher.problem.hourly_cap'));
    expect(html).not.toContain('server text');
  });

  it('деньги — с подписью «оценка по тарифам API»; путь отчёта — по просьбе', () => {
    const html = renderToStaticMarkup(
      <WatcherSummary status={base} elapsed={0} costUnit="money" showReportPath />,
    );
    expect(html).toContain('$0.010');
    expect(html).toContain(i18n.t('watcher.spendEstimate'));
    expect(html).toContain('C:/app/WATCH-REPORT.md');
  });

  it('проблема: известный код — текст словаря, неизвестный — фраза сервера', () => {
    const known = renderToStaticMarkup(
      <WatcherSummary
        status={{
          ...base,
          problem: { problemCode: 'cli_missing', message: 'server text', at: base.serverNow },
        }}
        elapsed={0}
        costUnit="tokens"
      />,
    );
    expect(known).toContain(i18n.t('watcher.problem.cli_missing'));
    expect(known).not.toContain('server text');

    const unknown = renderToStaticMarkup(
      <WatcherSummary
        status={{
          ...base,
          problem: {
            problemCode: 'future_code' as never,
            message: 'server text',
            detail: 'EACCES',
            at: base.serverNow,
          },
        }}
        elapsed={0}
        costUnit="tokens"
      />,
    );
    expect(unknown).toContain('server text');
    expect(unknown).toContain('EACCES');
  });
});
