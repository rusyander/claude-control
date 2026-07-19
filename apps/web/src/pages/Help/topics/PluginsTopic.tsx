import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  StepList,
  Callout,
  CapabilityGrid,
  OptionCards,
} from '../ui';

/** Документ раздела «Плагины». */
export function PluginsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.plugins.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyReady'), text: tr('whyReadyText') },
            { title: tr('whyUpdate'), text: tr('whyUpdateText') },
            { title: tr('whyOfficial'), text: tr('whyOfficialText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageWhere'), value: tr('storageWhereValue') },
            { label: tr('storageId'), value: tr('storageIdValue') },
            { label: tr('storageSource'), value: tr('storageSourceValue') },
            { label: tr('storageResult'), value: tr('storageResultValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'click',
              label: tr('flowClick'),
              caption: tr('flowClickCaption'),
              tone: 'accent',
              icon: 'plugins',
            },
            {
              id: 'cli',
              label: tr('flowCli'),
              caption: tr('flowCliCaption'),
              tone: 'info',
              isMono: true,
              icon: 'scripts',
            },
            {
              id: 'fetch',
              label: tr('flowFetch'),
              caption: tr('flowFetchCaption'),
              icon: 'link',
            },
            {
              id: 'ready',
              label: tr('flowReady'),
              caption: tr('flowReadyCaption'),
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
          can={[
            tr('canCatalog'),
            tr('canInstall'),
            tr('canUpdate'),
            tr('canToggle'),
            tr('canUninstall'),
            tr('canMarketplaces'),
            tr('canSee'),
          ]}
          cant={[tr('cantEdit'), tr('cantPick'), tr('cantCreate'), tr('cantOffline')]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: 'id', description: tr('fieldId') },
            { name: 'marketplace', description: tr('fieldMarketplace') },
            { name: 'version', description: tr('fieldVersion') },
            { name: 'scope', description: tr('fieldScope') },
            { name: 'installedAt', description: tr('fieldInstalled') },
            { name: 'installCount', description: tr('fieldCount') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('recipesTitle')}>
        <StepList
          steps={[
            { title: tr('recipe1'), text: tr('recipe1Text') },
            { title: tr('recipe2'), text: tr('recipe2Text') },
            { title: tr('recipe3'), text: tr('recipe3Text') },
            { title: tr('recipe4'), text: tr('recipe4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteCliTitle')}>
            {tr('noteCliText')}
          </Callout>
          <Callout tone="info" title={tr('noteSlowTitle')}>
            {tr('noteSlowText')}
          </Callout>
          <Callout tone="info" title={tr('noteContentTitle')}>
            {tr('noteContentText')}
          </Callout>
          <Callout tone="info" title={tr('noteManualTitle')}>
            {tr('noteManualText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
