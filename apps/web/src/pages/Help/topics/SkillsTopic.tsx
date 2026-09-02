import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Скиллы». */
export function SkillsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.skills.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOnDemand'), text: tr('whyOnDemandText') },
            { title: tr('whyProcess'), text: tr('whyProcessText') },
            { title: tr('whyPortable'), text: tr('whyPortableText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageFolder'), value: '~/.claude/skills/<name>/', isMono: true },
            { label: tr('storageMain'), value: tr('storageMainValue') },
            { label: tr('storageDisabled'), value: '~/.claude/skills-disabled/', isMono: true },
            { label: tr('storageOff'), value: tr('storageOffValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'folder',
              label: tr('flowFolder'),
              caption: tr('flowFolderCaption'),
              tone: 'accent',
              icon: 'folder',
            },
            {
              id: 'desc',
              label: tr('flowDescriptions'),
              caption: tr('flowDescriptionsCaption'),
              tone: 'info',
              icon: 'search',
            },
            {
              id: 'match',
              label: tr('flowMatch'),
              caption: tr('flowMatchCaption'),
              tone: 'warning',
              icon: 'check',
            },
            {
              id: 'body',
              label: tr('flowBody'),
              caption: tr('flowBodyCaption'),
              tone: 'success',
              icon: 'skills',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canCreate'),
            tr('canRename'),
            tr('canTree'),
            tr('canAssistant'),
            tr('canSearch'),
            tr('canToggle'),
            tr('canRestore'),
            tr('canSandbox'),
            tr('canLink'),
          ]}
          cant={[tr('cantAutoRead'), tr('cantGuarantee'), tr('cantVersions')]}
        />
      </HelpSection>

      <HelpSection title={tr('descriptionTitle')} caption={tr('descriptionCaption')}>
        <OptionCards
          items={[
            { title: tr('descGood'), text: tr('descGoodText') },
            { title: tr('descBad'), text: tr('descBadText') },
            { title: tr('descTip'), text: tr('descTipText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('templatesTitle')} caption={tr('templatesCaption')}>
        <OptionCards
          items={[
            { title: tr('tplMinimal'), text: tr('tplMinimalText') },
            { title: tr('tplRefs'), text: tr('tplRefsText') },
            { title: tr('tplFull'), text: tr('tplFullText') },
          ]}
        />
        <Callout tone="info" title={tr('templatesNote')} />
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
            {
              name: 'description',
              description: tr('fieldDescription'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'body', description: tr('fieldBody') },
            { name: 'files', description: tr('fieldFiles') },
            { name: 'groupIds', description: tr('fieldGroups') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('offTitle')} caption={tr('offCaption')}>
        <FlowDiagram
          ariaLabel={tr('offTitle')}
          nodes={[
            { id: 'toggle', label: tr('offToggle'), tone: 'warning', icon: 'close' },
            {
              id: 'move',
              label: tr('offMove'),
              caption: tr('offMoveCaption'),
              isMono: true,
              icon: 'folder',
            },
            {
              id: 'result',
              label: tr('offResult'),
              caption: tr('offResultCaption'),
              tone: 'info',
              icon: 'eyeOff',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('assistantTitle')} caption={tr('assistantCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('assistantForm'), text: tr('assistantFormText') },
            { title: tr('assistantStructure'), text: tr('assistantStructureText') },
          ]}
        />
        <Callout tone="info" title={tr('assistantNote')} />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteNestedTitle')}>
            {tr('noteNestedText')}
          </Callout>
          <Callout tone="info" title={tr('noteNameTitle')}>
            {tr('noteNameText')}
          </Callout>
          <Callout tone="danger" title={tr('noteDeleteTitle')}>
            {tr('noteDeleteText')}
          </Callout>
          <Callout tone="info" title={tr('noteDescTitle')}>
            {tr('noteDescText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
