import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PriorityLadder } from '@shared/ui/diagram';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  StepList,
  Callout,
  CapabilityGrid,
  OptionCards,
} from '../ui';

/**
 * Документ раздела «Права».
 *
 * Главная мысль раздела — приоритет решений, поэтому вместо схемы потока
 * здесь лестница: порядок ступеней и есть ответ на вопрос «почему запрет
 * победил разрешение».
 */
export function PermissionsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.permissions.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyHard'), text: tr('whyHardText') },
            { title: tr('whyQuiet'), text: tr('whyQuietText') },
            { title: tr('whySystem'), text: tr('whySystemText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="settings.json"
          rows={[
            { label: tr('storageFile'), value: tr('storageFileValue'), isMono: true },
            { label: tr('storageLocal'), value: tr('storageLocalValue'), isMono: true },
            { label: tr('storageId'), value: tr('storageIdValue') },
            { label: tr('storageMove'), value: tr('storageMoveValue') },
            { label: tr('storageOs'), value: tr('storageOsValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('priorityTitle')} caption={tr('priorityCaption')}>
        <PriorityLadder
          ariaLabel={tr('priorityTitle')}
          topLabel={tr('priorityTop')}
          bottomLabel={tr('priorityBottom')}
          steps={[
            { id: 'deny', label: 'deny', caption: tr('priorityDeny'), tone: 'danger' },
            { id: 'ask', label: 'ask', caption: tr('priorityAsk'), tone: 'warning' },
            { id: 'allow', label: 'allow', caption: tr('priorityAllow'), tone: 'success' },
          ]}
        />
        <Callout tone="info" title={tr('priorityNote')} />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canThree'),
            tr('canPattern'),
            tr('canPreset'),
            tr('canBulk'),
            tr('canMcp'),
            tr('canMove'),
            tr('canSee'),
            tr('canValidate'),
            tr('canAssistant'),
          ]}
          cant={[tr('cantWhy'), tr('cantProject'), tr('cantOrderCustom')]}
        />
      </HelpSection>

      <HelpSection title={tr('patternTitle')} caption={tr('patternCaption')}>
        <OptionCards
          items={[
            { title: tr('patternTool'), text: tr('patternToolText') },
            { title: tr('patternNarrow'), text: tr('patternNarrowText') },
            { title: tr('patternMcp'), text: tr('patternMcpText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('tabsTitle')}>
        <OptionCards
          items={[
            { title: tr('tabSystem'), text: tr('tabSystemText') },
            { title: tr('tabMcp'), text: tr('tabMcpText') },
            { title: tr('tabAll'), text: tr('tabAllText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('risksTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: tr('riskLow'),
              description: tr('riskLowText'),
              isMono: false,
              badge: 'low',
              badgeTone: 'success',
            },
            {
              name: tr('riskMedium'),
              description: tr('riskMediumText'),
              isMono: false,
              badge: 'medium',
              badgeTone: 'warning',
            },
            {
              name: tr('riskHigh'),
              description: tr('riskHighText'),
              isMono: false,
              badge: 'high',
              badgeTone: 'danger',
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
              name: 'pattern',
              description: tr('fieldPattern'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'decision',
              description: tr('fieldDecision'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'groupIds', description: tr('fieldGroups') },
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
          <Callout tone="warning" title={tr('noteDenyTitle')}>
            {tr('noteDenyText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteChatTitle')}>
            {tr('noteChatText')}
          </Callout>
          <Callout tone="info" title={tr('noteExactTitle')}>
            {tr('noteExactText')}
          </Callout>
          <Callout tone="info" title={tr('noteIdTitle')}>
            {tr('noteIdText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
