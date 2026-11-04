import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { machineStateLabel } from '@entities/CoreTask';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { ReportBodyProps } from './ReportBody.types';
import styles from './ReportBody.module.scss';

const VERDICT_TONE = {
  covered: 'success',
  waived: 'neutral',
  'n/a': 'neutral',
  open: 'warning',
  unknown: 'danger',
} as const;

/**
 * Разделы отчёта по порядку P96: единицы, требования с доказательствами, развилки по умолчанию,
 * непроверенное, остатки, предложения, поздние ответы. Пустой раздел назван «нет», а не скрыт:
 * «непроверенного нет» — это утверждение отчёта, его отсутствие на экране читалось бы иначе.
 * Тексты ядра — дословно (английская проза ядра, P32).
 */
export function ReportBody({ report }: ReportBodyProps) {
  const { t } = useTranslation();
  return (
    <Stack gap="var(--spacing-sm)" data-report-outcome={report.outcome}>
      <Section title={t('coreTimeline.report.units')} count={report.units.length}>
        {report.units.map((u) => (
          <li key={u.unitId}>
            <Typography variant="body-sm" as="span">
              {t('coreTimeline.report.unit', {
                name: u.name,
                state: machineStateLabel(t, 'unit', u.state),
                branch: u.branch,
              })}
            </Typography>
          </li>
        ))}
      </Section>
      <Section title={t('coreTimeline.report.requirements')} count={report.requirements.length}>
        {report.requirements.map((r) => (
          <li key={r.requirementId} data-report-requirement={r.verdict}>
            <Stack gap="var(--spacing-3xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Badge tone={VERDICT_TONE[r.verdict]}>
                  {t(`coreTimeline.report.verdict.${r.verdict}`)}
                </Badge>
                <Typography variant="body-sm" as="span">
                  {r.ordinal}. {r.text}
                </Typography>
              </Stack>
              {r.evidence.length > 0 && (
                <Typography variant="caption" color="muted" lang="en">
                  {t('coreTimeline.report.evidence')}: {r.evidence.join(', ')}
                </Typography>
              )}
            </Stack>
          </li>
        ))}
      </Section>
      <Section title={t('coreTimeline.report.forks')} count={report.forks.length}>
        {report.forks.map((f, i) => (
          <li key={i}>
            <Typography variant="body-sm" lang="en">
              {f.question}
            </Typography>
            <Typography variant="caption" color="muted" lang="en">
              {t('coreTimeline.report.chosen', { chosen: f.chosen })}
              {f.reason ? ` — ${f.reason}` : ''}
            </Typography>
          </li>
        ))}
      </Section>
      <Section title={t('coreTimeline.report.unverified')} count={report.unverified.length}>
        {report.unverified.map((u, i) => (
          <WhatWhy key={i} what={u.what} why={u.why} />
        ))}
      </Section>
      <Section title={t('coreTimeline.report.residuals')} count={report.residuals.length}>
        {report.residuals.map((r, i) => (
          <WhatWhy key={i} what={r.what} why={r.why} />
        ))}
      </Section>
      <Section title={t('coreTimeline.report.suggestions')} count={report.suggestions.length}>
        {report.suggestions.map((s, i) => (
          <li key={i}>
            <Typography variant="body-sm" as="span">
              {t(`coreTimeline.report.suggestion.${s.kind}`)}:{' '}
            </Typography>
            <Typography variant="body-sm" as="span" lang="en">
              {s.detail}
            </Typography>
          </li>
        ))}
      </Section>
      <Section title={t('coreTimeline.report.lateAnswers')} count={report.lateAnswers.length}>
        {report.lateAnswers.map((a) => (
          <li key={a.askId}>
            <Typography variant="caption" as="span">
              {a.askId} —{' '}
              {a.delivered
                ? t('coreTimeline.report.lateDelivered')
                : t('coreTimeline.report.lateNotDelivered')}
            </Typography>
          </li>
        ))}
      </Section>
    </Stack>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="body-sm" weight="medium">
        {title}
      </Typography>
      {count === 0 ? (
        <Typography variant="caption" color="subtle">
          {t('coreTimeline.report.none')}
        </Typography>
      ) : (
        <ul className={styles.list}>{children}</ul>
      )}
    </Stack>
  );
}

function WhatWhy({ what, why }: { what: string; why: string }) {
  return (
    <li>
      <Typography variant="body-sm" lang="en">
        {what}
      </Typography>
      <Typography variant="caption" color="muted" lang="en">
        {why}
      </Typography>
    </li>
  );
}
