import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Аналитика». */
export function AnalyticsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.analytics.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyLocal'), text: tr('whyLocalText') },
            { title: tr('whyWhere'), text: tr('whyWhereText') },
            { title: tr('whyCache'), text: tr('whyCacheText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSource'), value: tr('storageSourceValue'), isMono: true },
            { label: tr('storageWhat'), value: tr('storageWhatValue') },
            { label: tr('storageSkills'), value: tr('storageSkillsValue') },
            { label: tr('storageCache'), value: tr('storageCacheValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'files',
              label: tr('flowFiles'),
              caption: tr('flowFilesCaption'),
              tone: 'accent',
              icon: 'file',
            },
            {
              id: 'scan',
              label: tr('flowScan'),
              caption: tr('flowScanCaption'),
              tone: 'info',
              icon: 'search',
            },
            { id: 'sum', label: tr('flowSum'), caption: tr('flowSumCaption'), icon: 'analytics' },
            {
              id: 'view',
              label: tr('flowView'),
              caption: tr('flowViewCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[tr('canPeriod'), tr('canDetail'), tr('canLive'), tr('canTools'), tr('canSessions')]}
          cant={[tr('cantLimits'), tr('cantBill'), tr('cantOther'), tr('cantExport')]}
        />
      </HelpSection>

      <HelpSection title={tr('metricsTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
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

      <HelpSection title={tr('liveTitle')} caption={tr('liveCaption')} />

      <HelpSection title={tr('notesTitle')}>
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
          <Callout tone="info" title={tr('noteBigTitle')}>
            {tr('noteBigText')}
          </Callout>
          <Callout tone="info" title={tr('noteScopeTitle')}>
            {tr('noteScopeText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
