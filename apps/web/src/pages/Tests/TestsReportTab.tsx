import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { percentOf, useStartTestRun, useTestReport } from '@entities/ProjectTest';
import { automationTotal, redCases, statusTotals } from './model/reportMetrics';
import { TestsHealthCard } from './TestsHealthCard';
import { TestsQuarantineCard } from './TestsQuarantineCard';
import { TestsReleaseCard } from './TestsReleaseCard';
import { TestsRunDiff } from './TestsRunDiff';
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
  const start = useStartTestRun(projectPath);

  if (report.isLoading) return <SkeletonList rows={4} />;
  // Здоровье набора считается по САМОЙ библиотеке, а не по истории: набор без
  // единого прогона уже бывает с дублями и без оракулов, и прятать это за «нет
  // прогонов» значило бы молчать ровно там, где чинить дешевле всего.
  if (!report.data) {
    return (
      <Stack gap="var(--spacing-sm)">
        <EmptyState
          icon="analytics"
          title={t('tests.report.empty')}
          text={t('tests.report.emptyHint')}
        />
        <TestsHealthCard projectPath={projectPath} />
        <TestsQuarantineCard projectPath={projectPath} />
      </Stack>
    );
  }

  const data = report.data;
  const totals = statusTotals(data);
  // «С прошлого прогона» считается от последнего прогона С РЕЗУЛЬТАТАМИ:
  // генерация и импорт тоже лежат в истории, а сравнивать с ними нечего.
  const lastRun = data.runs.find((item) => item.results.length > 0);

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
            {/* Карантин показывается ТОЛЬКО когда он есть: строка «в карантине
                0» приучает не читать это место, а именно из него сборка узнаёт,
                почему она зелёная при красном кейсе. */}
            {data.totals.muted > 0 && (
              <Typography variant="body-sm">
                {t('tests.report.muted', { count: data.totals.muted })}
              </Typography>
            )}
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

      {/* Первое, что спрашивают у отчёта после регресса: что сломалось с
          прошлого раза. Тренд отвечает «стало хуже», а не «чем именно». */}
      {lastRun && (
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="body-sm" weight="medium" as="span">
                {t('tests.diff.title')}
              </Typography>
              {redCases(lastRun).length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Icon name="refresh" size={16} />}
                  disabled={start.isPending}
                  title={t('tests.diff.rerunHint')}
                  onClick={() => start.mutate({ mode: 'run', caseIds: redCases(lastRun) })}
                >
                  {t('tests.diff.rerun', { count: redCases(lastRun).length })}
                </Button>
              )}
            </Stack>
            <TestsRunDiff projectPath={projectPath} runId={lastRun.id} isOpenByDefault />
          </Stack>
        </Card>
      )}

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

      {/* Готовность релиза одним документом: вердикт, что мешает и чем это
          доказано. Стоит выше сводки по вехам — сводка отвечает «сколько
          прогонов», а вопрос задают другой. */}
      <TestsReleaseCard
        projectPath={projectPath}
        releases={(data.releases ?? []).map((item) => item.release)}
      />

      {/* Вехи: что проверено к релизу. Главное число здесь — непроверенное:
          именно оно отвечает на «можно ли отдавать», а «прогонов 12» не
          отвечает ни на что. Прогоны без вехи сюда не попадают. */}
      {(data.releases ?? []).length > 0 && (
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.report.releases')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('tests.report.releasesHint')}
            </Typography>
            {(data.releases ?? []).map((item) => (
              <Stack
                key={item.release}
                direction="row"
                gap="var(--spacing-2xs)"
                align="center"
                wrap
                className={styles.failureRow}
              >
                <Badge tone="info">{item.release}</Badge>
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.report.releaseCounts', {
                    runs: item.runs,
                    passed: item.passed,
                    failed: item.failed,
                  })}
                </Typography>
                <Badge tone={item.untested > 0 ? 'warning' : 'success'}>
                  {t('tests.report.releaseUntested', { count: item.untested })}
                </Badge>
                {item.lastRunAt && (
                  <Typography variant="caption" color="subtle" as="span">
                    {new Date(item.lastRunAt).toLocaleString()}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {/* Чем доказаны провалы. Голословный провал нельзя ни воспроизвести, ни
          завести дефектом — но и выбрасывать его нельзя: это полчаса работы
          прогона. Поэтому здесь счёт и список того, что надо перепройти. */}
      {(data.evidence?.failed ?? 0) > 0 && (
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.evidence.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('tests.evidence.hint')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              <Badge tone="danger">
                {t('tests.evidence.failed', { count: data.evidence?.failed ?? 0 })}
              </Badge>
              <Badge tone="success">
                {t('tests.evidence.proven', { count: data.evidence?.proven ?? 0 })}
              </Badge>
              <Badge tone="info">
                {t('tests.evidence.detailed', { count: data.evidence?.detailed ?? 0 })}
              </Badge>
            </Stack>
            {(data.evidence?.missing.length ?? 0) > 0 && (
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography variant="caption" color="warning" as="span">
                  {t('tests.evidence.missingList')}
                </Typography>
                {(data.evidence?.missing ?? []).slice(0, 20).map((item) => (
                  <Badge key={`${item.groupId}:${item.caseId}`} tone="warning">
                    {item.title}
                  </Badge>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="refresh" size={16} />}
                  disabled={start.isPending}
                  title={t('tests.evidence.recheckHint')}
                  onClick={() =>
                    start.mutate({
                      mode: 'run',
                      caseIds: [
                        ...new Set((data.evidence?.missing ?? []).map((item) => item.caseId)),
                      ],
                    })
                  }
                >
                  {t('tests.evidence.recheck')}
                </Button>
              </Stack>
            )}
            {(data.evidence?.flaky.length ?? 0) > 0 && (
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography variant="caption" color="warning" as="span">
                  {t('tests.evidence.flakyList')}
                </Typography>
                {(data.evidence?.flaky ?? []).slice(0, 20).map((item) => (
                  <Badge key={`${item.groupId}:${item.caseId}`} tone="warning">
                    {item.title}
                  </Badge>
                ))}
              </Stack>
            )}
          </Stack>
        </Card>
      )}

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

      <TestsHealthCard projectPath={projectPath} />
      <TestsQuarantineCard projectPath={projectPath} />
    </Stack>
  );
}
