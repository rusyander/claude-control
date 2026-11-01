import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReportReply } from '@agentdeck/contracts/core/panel-api';
import type { FinalReport } from '@agentdeck/contracts/core/report';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { ReportView } from './ReportView';

/**
 * Метка исхода в отчёте того же тона, что исход в шапке ленты: отменённая задача — не зелёный
 * «успех» (на одной странице шапка была красной, а отчёт зелёным).
 */

const TASK = '01900000-0000-7000-8000-000000000001';
const REF = { seq: 9, at: 'ended', sha256: 'a'.repeat(64), bytes: 10 } as const;

function render(outcome: FinalReport['outcome']): string {
  const client = new QueryClient();
  const reply: ReportReply = {
    taskId: TASK,
    ref: REF,
    report: {
      taskId: TASK,
      at: 'ended',
      outcome,
      units: [],
      requirements: [],
      forks: [],
      unverified: [],
      residuals: [],
      suggestions: [],
      lateAnswers: [],
    },
  };
  client.setQueryData(queryKeys.core.report(TASK), reply);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ReportView taskId={TASK} reportRef={REF} />
    </QueryClientProvider>,
  );
}

/** Классы метки с текстом исхода — тон виден по имени класса модуля. */
function outcomeBadge(markup: string, label: string): string {
  const match = new RegExp(`<span class="([^"]*)">${label}</span>`).exec(markup);
  if (!match?.[1]) throw new Error(`метка «${label}» не найдена: ${markup.slice(0, 400)}`);
  return match[1];
}

describe('ReportView — тон исхода', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it.each([
    ['cancelled', 'danger'],
    ['failed', 'danger'],
    ['done', 'success'],
    ['ready-to-publish', 'success'],
  ] as const)('%s → %s', (outcome, tone) => {
    const label = i18n.t(`coreTimeline.report.outcome.${outcome}`);
    const classes = outcomeBadge(render(outcome), label);
    expect(classes).toContain(tone);
    expect(classes).not.toContain(tone === 'danger' ? 'success' : 'danger');
  });
});
