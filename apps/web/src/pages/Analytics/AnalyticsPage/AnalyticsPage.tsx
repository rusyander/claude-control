import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonTiles, SkeletonChart } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { PageHeader } from '@shared/ui/page-header';
import { BarChart } from '@shared/ui/bar-chart';
import { TimeSeries } from '@shared/ui/time-series';
import { Heatmap } from '@shared/ui/heatmap';
import { DonutChart } from '@shared/ui/donut-chart';
import { formatCompact } from '@shared/lib/format-number';
import { useAnalytics, DEFAULT_PERIOD, periodKey } from '@entities/Analytics';
import type { AnalyticsPeriod } from '@entities/Analytics';
import { useSettings } from '@entities/AppConfig';
import { PeriodFilter } from '../PeriodFilter/PeriodFilter';
import { StatCard } from '../StatCard/StatCard';
import { LiveAgentsCard } from '../LiveAgentsCard/LiveAgentsCard';
import { LoweredRunsCard } from '../LoweredRunsCard/LoweredRunsCard';
import { ContourSpendCard } from '../ContourSpendCard/ContourSpendCard';
import { DetailModal } from '../DetailModal/DetailModal';
import { SessionsTab } from '../SessionsTab/SessionsTab';
import { SourceNote } from '../SourceNote/SourceNote';
import type { DetailKind } from '../DetailModal/DetailModal.types';
import { ANALYTICS_TABS, ANALYTICS_TAB_ICONS, isReportTab } from '../model/tabs';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import styles from './AnalyticsPage.module.scss';
import { buildJson } from '../model/buildJson';
import { buildReportCsv } from '../model/buildReportCsv';
import { formatNumber } from '../../../shared/lib/formatNumber';
import { formatMoney } from '../../../shared/lib/formatMoney';
import { formatPercent } from '../../../shared/lib/formatPercent';

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

  const { active: activeTab, select: selectTab } = usePageTab('analytics', ANALYTICS_TABS);
  // Счётчик «Сессий» — за весь период, а не длина списка последних: список
  // сервер обрезает, и подсказка у числа говорит, сколько в нём показано.
  const sessionCount = data?.periodSessions;
  const sessionHint =
    data && sessionCount !== undefined && sessionCount > data.recentSessions.length
      ? t('analytics.sessionsCountHint', {
          total: sessionCount,
          shown: data.recentSessions.length,
        })
      : undefined;
  const tabs = ANALYTICS_TABS.map((id) => ({
    id,
    label: t(`pageTabs.analytics.tab.${id}`),
    icon: ANALYTICS_TAB_ICONS[id],
    ...(id === 'sessions' && sessionCount !== undefined
      ? { count: sessionCount, countHint: sessionHint }
      : {}),
  }));

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('analytics.title')}
        subtitle={t('analytics.subtitle')}
        helpTopic="analytics"
        actions={
          // На «Агентах и контуре» период не действует (подпись вкладки так и
          // говорит), и живые кнопки периода и выгрузки обещали бы обратное.
          // fieldset гасит все кнопки внутри разом, не трогая их вёрстку.
          <fieldset className={styles.headerControls} disabled={activeTab === 'live'}>
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
          </fieldset>
        }
      />

      <PageTabs
        page="analytics"
        label={t('pageTabs.analytics.tabsLabel')}
        tabs={tabs}
        active={activeTab}
        onSelect={selectTab}
      />

      <PageTabPanel
        page="analytics"
        tab={activeTab}
        hint={t(`pageTabs.analytics.hint.${activeTab}`)}
      >
        {activeTab === 'live' && (
          <>
            <LiveAgentsCard />
            {/* Пустой журнал карточка не рисует вовсе — блока не будет, пока веер не
                уедет ступенью ниже. */}
            <LoweredRunsCard />
            {/* Расход через контур стоит ОТДЕЛЬНО и в цифры сводки не входит: там
                транскрипты этой машины, здесь — кадры `usage` через наш шлюз, и у
                работы через контур есть и то и другое. Сложенные, они посчитали бы
                одни токены дважды. */}
            <ContourSpendCard />
          </>
        )}

        {isReportTab(activeTab) && isLoading && (
          <>
            <SkeletonTiles count={5} />
            <SkeletonChart />
          </>
        )}

        {isReportTab(activeTab) && data && data.overall.requests === 0 && (
          <Typography color="subtle">{t('analytics.noData')}</Typography>
        )}

        {isReportTab(activeTab) && data && data.overall.requests > 0 && (
          <Stack gap="var(--spacing-lg)" className={styles.report} data-stale={isPlaceholderData}>
            <SourceNote providerId={data.providerId} unpricedModels={data.unpricedModels} />
            {activeTab === 'overview' && (
              <>
                <div className={styles.statGrid}>
                  <StatCard
                    label={t('analytics.totalTokens')}
                    value={formatCompact(data.overall.total, locale)}
                    detail={formatNumber(data.overall.total, locale)}
                  />
                  <StatCard
                    label={t('analytics.requests')}
                    value={formatNumber(data.overall.requests, locale)}
                    detail={t('analytics.activeSessions', { count: data.activeSessions })}
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
            странице есть — тепловая карта по часам на вкладке «Инструменты и часы».
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
              </>
            )}

            {activeTab === 'breakdown' && (
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
                      formatValue={(value) => formatCompact(value, locale)}
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
                      formatValue={(value) => formatCompact(value, locale)}
                      onItemClick={(id) => setDetail({ kind: 'project', id })}
                    />
                  </Stack>
                </Card>
              </div>
            )}

            {activeTab === 'activity' && (
              <>
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
                        formatValue={(value) => formatNumber(value, locale)}
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
                        formatValue={(value) => formatNumber(value, locale)}
                      />
                    </Stack>
                  </Card>
                </div>
              </>
            )}

            {activeTab === 'sessions' && (
              <SessionsTab
                sessions={data.recentSessions}
                locale={locale}
                providerId={data.providerId}
              />
            )}

            {/* Строка сканирования — про весь отчёт, поэтому стоит под каждым его разрезом. */}
            <Typography variant="caption" color="subtle">
              {t('analytics.scanInfo', { count: data.scannedFiles, ms: data.scanDurationMs })}
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
      </PageTabPanel>
    </Stack>
  );
}
