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

/** Документ раздела «Группы» — вместе со сценариями, они живут на той же странице. */
export function GroupsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.groups.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyBundle'), text: tr('whyBundleText') },
            { title: tr('whyEnv'), text: tr('whyEnvText') },
            { title: tr('whySimple'), text: tr('whySimpleText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageWhere'), value: tr('storageWhereValue') },
            { label: tr('storageWhy'), value: tr('storageWhyValue') },
            { label: tr('storageAuto'), value: tr('storageAutoValue') },
            { label: tr('storageMarker'), value: tr('storageMarkerValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canCollect'),
            tr('canToggleGroup'),
            tr('canGroupEnv'),
            tr('canToggleAutomation'),
            tr('canBadge'),
            tr('canConflict'),
            tr('canSandbox'),
            tr('canAutomation'),
            tr('canAssistant'),
          ]}
          cant={[
            tr('cantOverride'),
            tr('cantRevive'),
            tr('cantKnow'),
            tr('cantMagic'),
            tr('cantNest'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('groupTitle')}>
        <OptionCards
          items={[
            { title: tr('groupMembers'), text: tr('groupMembersText') },
            { title: tr('groupToggle'), text: tr('groupToggleText') },
            { title: tr('groupEnv'), text: tr('groupEnvText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('toggleTitle')} caption={tr('toggleCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('toggleManual'), text: tr('toggleManualText') },
            { title: tr('toggleTwo'), text: tr('toggleTwoText') },
            { title: tr('toggleSingle'), text: tr('toggleSingleText') },
            { title: tr('toggleDelete'), text: tr('toggleDeleteText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('automationTitle')} caption={tr('automationCaption')}>
        <OptionCards
          items={[
            { title: tr('autoWhen'), text: tr('autoWhenText') },
            { title: tr('autoFilter'), text: tr('autoFilterText') },
            { title: tr('autoWhat'), text: tr('autoWhatText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'scenario',
              label: tr('flowScenario'),
              caption: tr('flowScenarioCaption'),
              tone: 'accent',
              icon: 'groups',
            },
            {
              id: 'compile',
              label: tr('flowCompile'),
              caption: tr('flowCompileCaption'),
              tone: 'info',
              icon: 'refresh',
            },
            {
              id: 'hook',
              label: tr('flowHook'),
              caption: tr('flowHookCaption'),
              icon: 'hooks',
              isMono: true,
            },
            {
              id: 'run',
              label: tr('flowRun'),
              caption: tr('flowRunCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'name',
              description: tr('fieldName'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'description', description: tr('fieldDescription') },
            { name: 'members', description: tr('fieldMembers') },
            { name: 'env', description: tr('fieldEnv') },
            { name: 'trigger', description: tr('fieldTrigger') },
            { name: 'action', description: tr('fieldAction') },
            {
              name: 'compiledHookId',
              description: tr('fieldCompiled'),
              badge: t('help.common.readOnly'),
            },
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
          <Callout tone="danger" title={tr('noteDeleteTitle')}>
            {tr('noteDeleteText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRebuildTitle')}>
            {tr('noteRebuildText')}
          </Callout>
          <Callout tone="info" title={tr('notePermTitle')}>
            {tr('notePermText')}
          </Callout>
          <Callout tone="info" title={tr('noteInvisibleTitle')}>
            {tr('noteInvisibleText')}
          </Callout>
          <Callout tone="info" title={tr('noteConflictTitle')}>
            {tr('noteConflictText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
