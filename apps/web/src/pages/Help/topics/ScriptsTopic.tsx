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

/** Документ раздела «Скрипты». */
export function ScriptsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.scripts.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyEdit'), text: tr('whyEditText') },
            { title: tr('whyOrphans'), text: tr('whyOrphansText') },
            { title: tr('whyTest'), text: tr('whyTestText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="hooks/"
          rows={[
            { label: tr('storageFolder'), value: '~/.claude/hooks/', isMono: true },
            { label: tr('storageExt'), value: tr('storageExtValue') },
            { label: tr('storageDesc'), value: tr('storageDescValue') },
            { label: tr('storageUsed'), value: tr('storageUsedValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'stdin',
              label: tr('flowStdin'),
              caption: tr('flowStdinCaption'),
              tone: 'accent',
              isMono: true,
            },
            {
              id: 'code',
              label: tr('flowCode'),
              caption: tr('flowCodeCaption'),
              tone: 'info',
              icon: 'scripts',
            },
            {
              id: 'stdout',
              label: tr('flowStdout'),
              caption: tr('flowStdoutCaption'),
              isMono: true,
            },
            {
              id: 'exit',
              label: tr('flowExit'),
              caption: tr('flowExitCaption'),
              tone: 'warning',
              icon: 'permissions',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canWrite'),
            tr('canTemplate'),
            tr('canBulkTemplates'),
            tr('canProbe'),
            tr('canSee'),
            tr('canExpand'),
            tr('canRename'),
            tr('canLang'),
            tr('canAssistant'),
          ]}
          cant={[tr('cantAuto'), tr('cantSchedule'), tr('cantInstall'), tr('cantDebug')]}
        />
      </HelpSection>

      <HelpSection title={tr('answersTitle')} caption={tr('answersCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('answerExit'), text: tr('answerExitText') },
            { title: tr('answerJson'), text: tr('answerJsonText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('templatesTitle')} caption={tr('templatesCaption')}>
        <OptionCards
          items={[
            { title: tr('tplBlank'), text: tr('tplBlankText') },
            { title: tr('tplGuard'), text: tr('tplGuardText') },
            { title: tr('tplFormat'), text: tr('tplFormatText') },
            { title: tr('tplBrief'), text: tr('tplBriefText') },
          ]}
        />
        <Callout tone="success" title={tr('bulkTitle')}>
          {tr('bulkText')}
        </Callout>
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
              name: 'content',
              description: tr('fieldContent'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'path',
              description: tr('fieldPath'),
              badge: t('help.common.readOnly'),
            },
            {
              name: 'isUsed',
              description: tr('fieldIsUsed'),
              badge: t('help.common.readOnly'),
            },
            {
              name: 'sizeBytes, modifiedAt',
              description: tr('fieldSize'),
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
          <Callout tone="info" title={tr('noteUnusedTitle')}>
            {tr('noteUnusedText')}
          </Callout>
          <Callout tone="info" title={tr('noteInterpreterTitle')}>
            {tr('noteInterpreterText')}
          </Callout>
          <Callout tone="success" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
