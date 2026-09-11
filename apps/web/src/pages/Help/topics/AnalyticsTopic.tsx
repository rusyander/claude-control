import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { AnalyticsGuideSections } from './AnalyticsGuideSections';
import { AnalyticsLimitsSections } from './AnalyticsLimitsSections';

/**
 * Документ раздела «Аналитика».
 *
 * Порядок тот же, что у соседей: зачем это вообще → схема происхождения чисел →
 * два пути в снимках (отчёт и живой срез) → чем раздел НЕ является → что читает и
 * пишет → что умеет и чего нет → пределы → что означают показатели → понижённые
 * прогоны → тонкости.
 *
 * Блок понижений стоит отдельно и последним из крупных: он единственный на
 * странице считает не расход, а выполнение планки сдачи, и мерить его теми же
 * глазами, что и токены, — ошибка.
 */
export function AnalyticsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.analytics.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная: первое, что ей нужно сказать, — из чего она состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyLocal'), text: tr('whyLocalText') },
            { title: tr('whyWhere'), text: tr('whyWhereText') },
            { title: tr('whyCache'), text: tr('whyCacheText') },
          ]}
        />
      </HelpSection>

      <AnalyticsGuideSections tr={tr} />

      <AnalyticsLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('metricsTitle')}>
        <FieldTable
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            { name: tr('metricTotal'), description: tr('metricTotalText'), isMono: false },
            { name: tr('metricCache'), description: tr('metricCacheText'), isMono: false },
            { name: tr('metricCost'), description: tr('metricCostText'), isMono: false },
            {
              name: tr('metricRequests'),
              description: tr('metricRequestsText'),
              isMono: false,
            },
            { name: tr('metricOutput'), description: tr('metricOutputText'), isMono: false },
            { name: tr('metricHours'), description: tr('metricHoursText'), isMono: false },
            { name: tr('metricSessions'), description: tr('metricSessionsText'), isMono: false },
            { name: tr('metricScan'), description: tr('metricScanText'), isMono: false },
          ]}
        />
      </HelpSection>

      {/* Единственный блок страницы, который считает не расход, а честность
          сдачи, — поэтому объясняется отдельно, с границами того, что панель
          вообще способна увидеть. */}
      <HelpSection title={tr('loweredTitle')} caption={tr('loweredCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('loweredWhen'), text: tr('loweredWhenText') },
            { title: tr('loweredRow'), text: tr('loweredRowText') },
            { title: tr('loweredSeen'), text: tr('loweredSeenText') },
            { title: tr('loweredCrash'), text: tr('loweredCrashText') },
            { title: tr('loweredKinds'), text: tr('loweredKindsText') },
            { title: tr('loweredWhere'), text: tr('loweredWhereText') },
          ]}
        />
        <Callout tone="warning" title={tr('loweredNote')} />
      </HelpSection>

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteLimitsTitle')}>
            {tr('noteLimitsText')}
          </Callout>
          <Callout tone="warning" title={tr('noteCostTitle')}>
            {tr('noteCostText')}
          </Callout>
          <Callout tone="success" title={tr('noteLiveTitle')}>
            {tr('noteLiveText')}
          </Callout>
          <Callout tone="info" title={tr('noteWholeTitle')}>
            {tr('noteWholeText')}
          </Callout>
          <Callout tone="info" title={tr('noteProjectTitle')}>
            {tr('noteProjectText')}
          </Callout>
          <Callout tone="info" title={tr('noteScopeTitle')}>
            {tr('noteScopeText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
