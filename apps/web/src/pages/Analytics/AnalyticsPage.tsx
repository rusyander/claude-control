import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonTiles, SkeletonChart } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { PageHeader } from '@shared/ui/page-header';
import { BarChart } from '@shared/ui/bar-chart';
import { TimeSeries } from '@shared/ui/time-series';
import { Heatmap } from '@shared/ui/heatmap';
import { DonutChart } from '@shared/ui/donut-chart';
import { formatCompact, formatMoney, formatNumber, formatPercent } from '@shared/lib/format-number';
import { useAnalytics, DEFAULT_PERIOD, periodKey } from '@entities/Analytics';
import type { AnalyticsPeriod } from '@entities/Analytics';
import { useSettings } from '@entities/AppConfig';
import { PeriodFilter } from './PeriodFilter';
import { StatCard } from './StatCard';
import { LiveAgentsCard } from './LiveAgentsCard';
import { DetailModal } from './DetailModal';
import type { DetailKind } from './DetailModal.types';
import { buildReportCsv, buildJson } from './model/report';
import styles from './AnalyticsPage.module.scss';

/** Аналитика по локальным транскриптам: расход, проекты, сессии, живые процессы. */
export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<AnalyticsPeriod>(DEFAULT_PERIOD);
  const [detail, setDetail] = useState<{ kind: DetailKind; id: string } | null>(null);
  // isPlaceholderData — на экране отчёт за прошлый период, новый ещё считается.
  const { data, isLoading, isPlaceholderData } = useAnalytics(period);
  const { data: settings } = useSettings();

  const locale = i18n.language;
  // Единицы расхода уважают настройку: те же токены или их денежная оценка.
  const costUnit = settings?.costUnit ?? 'tokens';

  // Выгрузка: числа только на экране мешают собрать отчёт — отдаём файлом.
  const download = (filename: string, content: string, mime: string): void => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const suffix = periodKey(period);

  const exportJson = (): void => {
    if (data) download(`analytics-${suffix}.json`, buildJson(data), 'application/json');
  };

  const exportCsv = (): void => {
    if (!data) return;
    download(`analytics-${suffix}.csv`, buildReportCsv(data), 'text/csv');
  };

  const hasData = Boolean(data && data.overall.requests > 0);

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('analytics.title')}
        subtitle={t('analytics.subtitle')}
        helpTopic="analytics"
        actions={
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <PeriodFilter value={period} onChange={setPeriod} />
            {/*
              Кнопки выгрузки всегда на месте и лишь гаснут без данных. Пока они
              появлялись и исчезали вместе с ответом, ряд фильтров
              перевёрстывался на каждое переключение периода.
            */}
            <Button
              size="sm"
              variant="ghost"
              disabled={!hasData}
              onClick={exportCsv}
              title={t('analytics.exportCsv')}
            >
              CSV
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!hasData}
              onClick={exportJson}
              title={t('analytics.exportJson')}
            >
              JSON
            </Button>
          </Stack>
        }
      />

      <LiveAgentsCard />

      {isLoading && (
        <>
          <SkeletonTiles count={5} />
          <SkeletonChart />
        </>
      )}

      {data && data.overall.requests === 0 && (
        <Typography color="subtle">{t('analytics.noData')}</Typography>
      )}

      {data && data.overall.requests > 0 && (
        <Stack gap="var(--spacing-lg)" className={styles.report} data-stale={isPlaceholderData}>
          <div className={styles.statGrid}>
            <StatCard
              label={t('analytics.totalTokens')}
              value={formatCompact(data.overall.total, locale)}
              detail={formatNumber(data.overall.total, locale)}
            />
            <StatCard
              label={t('analytics.requests')}
              value={formatNumber(data.overall.requests, locale)}
              detail={`${data.activeSessions} ${t('analytics.activeSessions')}`}
            />
            <StatCard
              label={t('analytics.outputTokens')}
              value={formatCompact(data.overall.output, locale)}
              detail={formatNumber(data.overall.output, locale)}
            />
            <StatCard
              label={t('analytics.cacheHit')}
              value={formatPercent(data.cacheHitRatio, locale)}
              hint={t('analytics.cacheHitHint')}
              detail={formatCompact(data.overall.cacheRead, locale)}
            />
            <StatCard
              label={t('analytics.estimatedCost')}
              value={formatMoney(data.estimatedCost, locale)}
              hint={t('analytics.estimatedCostHint')}
              detail={t('analytics.estimatedCostDetail')}
            />
          </div>

          {/*
            График по дням нужен от двух точек: у периода «Сегодня» их одна, и
            карточка занимала бы экран пустым полем. Разрез внутри суток на
            странице есть — тепловая карта по часам ниже.
          */}
          {data.byDay.length > 1 && (
            <Card padding="md">
              <Stack gap="var(--spacing-sm)">
                <Stack gap="var(--spacing-3xs)">
                  <Typography variant="body" weight="medium">
                    {t('analytics.byDay')}
                  </Typography>
                  <Typography variant="caption" color="subtle">
                    {t('analytics.byDayHint')}
                  </Typography>
                </Stack>

                <TimeSeries
                  seriesName={t('analytics.byDay')}
                  points={data.byDay.map((day) => ({
                    label: day.date.slice(5),
                    value: costUnit === 'money' ? day.estimatedCost : day.totals.total,
                    valueLabel:
                      costUnit === 'money'
                        ? formatMoney(day.estimatedCost, locale)
                        : `${formatCompact(day.totals.total, locale)} · ${formatNumber(day.totals.requests, locale)}`,
                  }))}
                />
              </Stack>
            </Card>
          )}

          <div className={styles.twoColumns}>
            <Card padding="md">
              <Stack gap="var(--spacing-sm)">
                <Typography variant="body" weight="medium">
                  {t('analytics.byModel')}
                </Typography>
                <BarChart
                  items={data.byModel.map((model, index) => ({
                    id: model.model,
                    label: model.model,
                    value: model.totals.total,
                    valueLabel: formatCompact(model.totals.total, locale),
                    seriesIndex: index + 1,
                    hint: `${formatNumber(model.totals.requests, locale)} · ${formatMoney(model.estimatedCost, locale)}`,
                  }))}
                  onItemClick={(id) => setDetail({ kind: 'model', id })}
                />
              </Stack>
            </Card>

            <Card padding="md">
              <Stack gap="var(--spacing-sm)">
                <Typography variant="body" weight="medium">
                  {t('analytics.byProject')}
                </Typography>
                <BarChart
                  items={data.byProject.map((project) => ({
                    id: project.project,
                    label: project.displayName,
                    value: project.totals.total,
                    valueLabel: formatCompact(project.totals.total, locale),
                    seriesIndex: 1,
                    hint: project.project,
                  }))}
                  limit={8}
                  onItemClick={(id) => setDetail({ kind: 'project', id })}
                />
              </Stack>
            </Card>
          </div>

          <Card padding="md">
            <Stack gap="var(--spacing-sm)">
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body" weight="medium">
                  {t('analytics.cacheComposition')}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {t('analytics.cacheCompositionHint')}
                </Typography>
              </Stack>

              <DonutChart
                ariaLabel={t('analytics.cacheComposition')}
                centerValue={formatPercent(data.cacheHitRatio, locale)}
                centerLabel={t('analytics.cacheHit')}
                segments={[
                  {
                    id: 'cacheRead',
                    label: t('analytics.cacheRead'),
                    value: data.overall.cacheRead,
                    valueLabel: formatCompact(data.overall.cacheRead, locale),
                    seriesIndex: 3,
                  },
                  {
                    id: 'input',
                    label: t('analytics.inputTokens'),
                    value: data.overall.input,
                    valueLabel: formatCompact(data.overall.input, locale),
                    seriesIndex: 1,
                  },
                  {
                    id: 'output',
                    label: t('analytics.outputTokens'),
                    value: data.overall.output,
                    valueLabel: formatCompact(data.overall.output, locale),
                    seriesIndex: 2,
                  },
                  {
                    id: 'cacheCreation',
                    label: t('analytics.cacheCreation'),
                    value: data.overall.cacheCreation,
                    valueLabel: formatCompact(data.overall.cacheCreation, locale),
                    seriesIndex: 4,
                  },
                ]}
              />
            </Stack>
          </Card>

          <Card padding="md">
            <Stack gap="var(--spacing-sm)">
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body" weight="medium">
                  {t('analytics.byHour')}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {t('analytics.byHourHint')}
                </Typography>
              </Stack>

              <Heatmap
                ariaLabel={t('analytics.byHour')}
                columns={24}
                scale={{ min: t('analytics.activityLess'), max: t('analytics.activityMore') }}
                cells={data.byHour.map((hour) => ({
                  id: `${hour.hour}`,
                  label: `${hour.hour}:00`,
                  value: hour.requests,
                  valueLabel: `${formatNumber(hour.requests, locale)} · ${formatCompact(hour.tokens, locale)}`,
                }))}
              />
            </Stack>
          </Card>

          <div className={styles.twoColumns}>
            <Card padding="md">
              <Stack gap="var(--spacing-sm)">
                <Typography variant="body" weight="medium">
                  {t('analytics.topTools')}
                </Typography>
                <BarChart
                  items={data.topTools.map((tool) => ({
                    id: tool.name,
                    label: tool.name,
                    value: tool.count,
                    valueLabel: formatNumber(tool.count, locale),
                    seriesIndex: 5,
                  }))}
                  limit={10}
                />
              </Stack>
            </Card>

            <Card padding="md">
              <Stack gap="var(--spacing-sm)">
                <Typography variant="body" weight="medium">
                  {t('analytics.topSkills')}
                </Typography>
                <BarChart
                  items={data.topSkills.map((skill) => ({
                    id: skill.name,
                    label: skill.name,
                    value: skill.count,
                    valueLabel: formatNumber(skill.count, locale),
                    seriesIndex: 2,
                  }))}
                  limit={10}
                />
              </Stack>
            </Card>
          </div>

          <Card padding="md">
            <Stack gap="var(--spacing-sm)">
              <Typography variant="body" weight="medium">
                {t('analytics.recentSessions')}
              </Typography>

              <Stack>
                {data.recentSessions.map((session) => (
                  <Stack
                    key={session.sessionId}
                    direction="row"
                    align="center"
                    justify="between"
                    gap="var(--spacing-sm)"
                    className={styles.sessionRow}
                  >
                    <Stack gap="var(--spacing-3xs)">
                      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                        <Typography variant="body-sm" weight="medium" as="span">
                          {session.displayName}
                        </Typography>
                        {session.isActive && (
                          <Badge tone="success" withDot>
                            {t('analytics.sessionActive')}
                          </Badge>
                        )}
                        {session.gitBranch && <Badge tone="neutral">{session.gitBranch}</Badge>}
                      </Stack>
                      <Typography variant="caption" color="subtle" as="span">
                        {new Date(session.lastActivity).toLocaleString(locale)} ·{' '}
                        {session.models.join(', ')}
                      </Typography>
                    </Stack>

                    <Typography variant="body-sm" color="muted" as="span">
                      {formatCompact(session.totals.total, locale)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          </Card>

          <Card padding="md">
            <Stack gap="var(--spacing-xs)" className={styles.limitsNote}>
              <Typography variant="body-sm" weight="medium">
                {t('analytics.limitsTitle')}
              </Typography>
              <Typography variant="body-sm" color="muted">
                {t('analytics.limitsText')}
              </Typography>
            </Stack>
          </Card>

          <Typography variant="caption" color="subtle">
            {t('analytics.scanInfo', { files: data.scannedFiles, ms: data.scanDurationMs })}
          </Typography>

          {detail && (
            <DetailModal
              isOpen
              onOpenChange={(isOpen) => !isOpen && setDetail(null)}
              kind={detail.kind}
              id={detail.id}
              analytics={data}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}
