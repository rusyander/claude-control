import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { percentOf, useTestReport } from '@entities/ProjectTest';
import { automationTotal, statusTotals } from './model/reportMetrics';
import { TestsTrend } from './TestsTrend';
import styles from './TestsPage.module.scss';

/**
 * Отчёт по истории: где красное, где непокрыто, что нестабильно и сколько это
 * стоило.
 *
 * Считает всё сервер по файлам прогонов — панель только рисует. Своей
 * библиотеки графиков здесь нет намеренно: четыре полосы и одна линия
 * выражаются полусотней строк CSS и SVG, а пакет с графиками весит больше всего
 * остального раздела и тянется в общий бандл.
 */
export function TestsReportTab({ projectPath }: { projectPath: string | undefined }) {
  const { t } = useTranslation();
  const report = useTestReport(projectPath);

  if (report.isLoading) return <SkeletonList rows={4} />;
  if (!report.data) {
    return (
      <EmptyState
        icon="analytics"
        title={t('tests.report.empty')}
        text={t('tests.report.emptyHint')}
      />
    );
  }

  const data = report.data;
  const totals = statusTotals(data);

  return (
    <Stack gap="var(--spacing-sm)">
      <div className={styles.cards}>
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="caption" color="subtle">
              {t('tests.report.status')}
            </Typography>
            <div className={styles.stack}>
              <span
                className={`${styles.stackPart} ${styles.stackPassed}`}
                style={{ width: `${percentOf(totals.passed, totals.total)}%` }}
              />
              <span
                className={`${styles.stackPart} ${styles.stackFailed}`}
                style={{ width: `${percentOf(totals.failed, totals.total)}%` }}
              />
              <span
                className={`${styles.stackPart} ${styles.stackUnknown}`}
                style={{ width: `${percentOf(totals.unknown, totals.total)}%` }}
              />
            </div>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              <Badge tone="success">{t('tests.report.passed', { count: totals.passed })}</Badge>
              <Badge tone="danger">{t('tests.report.failed', { count: totals.failed })}</Badge>
              <Badge tone="neutral">{t('tests.report.unknown', { count: totals.unknown })}</Badge>
            </Stack>
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="caption" color="subtle">
              {t('tests.report.automation')}
            </Typography>
            <div className={styles.stack}>
              <span
                className={`${styles.stackPart} ${styles.stackPassed}`}
                style={{ width: `${percentOf(data.automation.automated, automationTotal(data))}%` }}
              />
              <span
                className={`${styles.stackPart} ${styles.stackToAutomate}`}
                style={{
                  width: `${percentOf(data.automation.toAutomate, automationTotal(data))}%`,
                }}
              />
            </div>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              <Badge tone="success">
                {t('tests.automation.automated')}: {data.automation.automated}
              </Badge>
              <Badge tone="info">
                {t('tests.automation.toAutomate')}: {data.automation.toAutomate}
              </Badge>
              <Badge tone="neutral">
                {t('tests.automation.manual')}: {data.automation.manual}
              </Badge>
            </Stack>
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="caption" color="subtle">
              {t('tests.report.totals')}
            </Typography>
            <Typography variant="body-sm">
              {t('tests.report.runsCount', { count: data.totals.runs })}
            </Typography>
            <Typography variant="body-sm">
              {t('tests.report.tokens', { count: data.totals.tokens })}
            </Typography>
            <Typography variant="body-sm">
              {t('tests.report.cost', { value: data.totals.costUsd.toFixed(2) })}
            </Typography>
            <Typography variant="body-sm">
              {t('tests.report.duration', {
                minutes: Math.round(data.totals.durationMs / 60000),
              })}
            </Typography>
            {data.totals.lastRunAt && (
              <Typography variant="caption" color="subtle">
                {t('tests.report.lastRun', {
                  time: new Date(data.totals.lastRunAt).toLocaleString(),
                })}
              </Typography>
            )}
          </Stack>
        </Card>
      </div>

      <Card padding="md">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.report.trend')}
          </Typography>
          <TestsTrend runs={data.runs} />
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.report.areas')}
          </Typography>
          {data.areas.length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('tests.report.areasEmpty')}
            </Typography>
          )}
          {data.areas.map((area) => (
            <Stack key={area.area} gap="var(--spacing-3xs)">
              <Stack direction="row" justify="between" align="center">
                <Typography variant="caption" as="span">
                  {area.area || t('tests.report.areaNone')}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.report.areaCounts', {
                    passed: area.passed,
                    total: area.total,
                    percent: percentOf(area.passed, area.total),
                  })}
                </Typography>
              </Stack>
              <div className={styles.stack}>
                <span
                  className={`${styles.stackPart} ${styles.stackPassed}`}
                  style={{ width: `${percentOf(area.passed, area.total)}%` }}
                />
                <span
                  className={`${styles.stackPart} ${styles.stackFailed}`}
                  style={{ width: `${percentOf(area.failed, area.total)}%` }}
                />
              </div>
            </Stack>
          ))}
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.report.flaky')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.report.flakyHint')}
          </Typography>
          {data.flaky.length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('tests.report.flakyEmpty')}
            </Typography>
          )}
          {data.flaky.map((item) => (
            <Stack
              key={`${item.groupId}:${item.caseId}`}
              direction="row"
              gap="var(--spacing-2xs)"
              align="center"
              wrap
            >
              <Badge
                tone={item.stability < 60 ? 'danger' : 'warning'}
              >{`${item.stability}%`}</Badge>
              <Typography variant="body-sm" as="span">
                {item.title}
              </Typography>
              <Typography variant="caption" color="subtle" as="span">
                {t('tests.report.flakyRuns', { runs: item.runs, flips: item.flips })}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Card>

      {/* Провалы, сведённые по причине: одна упавшая авторизация красит
          половину набора, и без этой сводки она читается как полсотни разных
          бед. Пусто — либо всё зелено, либо исполнитель не написал, что видел. */}
      <Card padding="md">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.report.failures')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.report.failuresHint')}
          </Typography>
          {(data.failures ?? []).length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('tests.report.failuresEmpty')}
            </Typography>
          )}
          {(data.failures ?? []).map((item) => (
            <Stack key={item.reason} gap="var(--spacing-3xs)" className={styles.failureRow}>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Badge tone="danger">{item.count}</Badge>
                <Typography variant="body-sm" as="span">
                  {item.reason}
                </Typography>
              </Stack>
              <Typography variant="caption" color="subtle">
                {t('tests.report.failuresCases', {
                  count: item.cases.length,
                  names: item.cases
                    .slice(0, 4)
                    .map((one) => one.title)
                    .join(' · '),
                })}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
