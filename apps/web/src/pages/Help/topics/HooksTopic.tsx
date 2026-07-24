import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HOOK_EVENT_INFO } from '@claude-control/contracts';
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
 * Документ раздела «Хуки».
 *
 * Таблица событий строится из HOOK_EVENT_INFO: список событий, поддержку
 * фильтра и способность блокировать берём из контракта, чтобы справка не
 * разошлась с формой. Тексты при этом свои — в контракте они только на русском.
 */
export function HooksTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.hooks.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyGuarantee'), text: tr('whyGuaranteeText') },
            { title: tr('whyBlock'), text: tr('whyBlockText') },
            { title: tr('whyAutomate'), text: tr('whyAutomateText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="settings.json"
          rows={[
            { label: tr('storageFile'), value: tr('storageFileValue'), isMono: true },
            { label: tr('storageLocal'), value: tr('storageLocalValue'), isMono: true },
            { label: tr('storageScripts'), value: '~/.claude/hooks/', isMono: true },
            { label: tr('storageStructure'), value: tr('storageStructureValue') },
            { label: tr('storageOff'), value: tr('storageOffValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'event',
              label: tr('flowEvent'),
              caption: tr('flowEventCaption'),
              tone: 'accent',
              icon: 'hooks',
            },
            {
              id: 'matcher',
              label: tr('flowMatcher'),
              caption: tr('flowMatcherCaption'),
              icon: 'search',
            },
            {
              id: 'script',
              label: tr('flowScript'),
              caption: tr('flowScriptCaption'),
              tone: 'info',
              icon: 'scripts',
            },
            {
              id: 'decision',
              label: tr('flowDecision'),
              caption: tr('flowDecisionCaption'),
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
            tr('canPreset'),
            tr('canScript'),
            tr('canMatcher'),
            tr('canBulkPresets'),
            tr('canAssistant'),
            tr('canProbe'),
            tr('canToggle'),
            tr('canOrder'),
            tr('canTimeout'),
          ]}
          cant={[tr('cantBlockAll'), tr('cantStable'), tr('cantLocal'), tr('cantDebug')]}
        />
      </HelpSection>

      <HelpSection title={tr('eventsTitle')} caption={tr('eventsCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={HOOK_EVENT_INFO.map((info) => ({
            name: info.event,
            description: tr(`evt${info.event}`),
            ...(info.canBlock ? { badge: tr('badgeBlocks'), badgeTone: 'danger' as const } : {}),
            ...(info.supportsMatcher
              ? { badge2: tr('badgeMatcher'), badge2Tone: 'info' as const }
              : {}),
          }))}
        />
      </HelpSection>

      <HelpSection title={tr('templatesTitle')} caption={tr('templatesCaption')}>
        <OptionCards
          items={[
            { title: tr('tplMessage'), text: tr('tplMessageText') },
            { title: tr('tplGuard'), text: tr('tplGuardText') },
            { title: tr('tplShell'), text: tr('tplShellText') },
            { title: tr('tplBlank'), text: tr('tplBlankText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('presetsTitle')} caption={tr('presetsCaption')}>
        <OptionCards
          items={[
            { title: tr('presetDestructive'), text: tr('presetDestructiveText') },
            { title: tr('presetSecret'), text: tr('presetSecretText') },
            { title: tr('presetFormat'), text: tr('presetFormatText') },
            { title: tr('presetBrief'), text: tr('presetBriefText') },
            { title: tr('presetCheckpoint'), text: tr('presetCheckpointText') },
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
              name: 'event',
              description: tr('fieldEvent'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'matchers', description: tr('fieldMatchers') },
            { name: 'scriptName', description: tr('fieldScriptName') },
            { name: 'template', description: tr('fieldTemplate') },
            { name: 'description', description: tr('fieldDescription') },
            { name: 'message', description: tr('fieldMessage') },
            { name: 'guardPatterns', description: tr('fieldGuardPatterns') },
            { name: 'command', description: tr('fieldCommand') },
            { name: 'timeout', description: tr('fieldTimeout') },
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
          <Callout tone="danger" title={tr('noteBrokenTitle')}>
            {tr('noteBrokenText')}
          </Callout>
          <Callout tone="warning" title={tr('noteExitTitle')}>
            {tr('noteExitText')}
          </Callout>
          <Callout tone="info" title={tr('noteIdTitle')}>
            {tr('noteIdText')}
          </Callout>
          <Callout tone="info" title={tr('noteDisabledTitle')}>
            {tr('noteDisabledText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteScriptTitle')}>
            {tr('noteScriptText')}
          </Callout>
          {/* Хуки OpenCode — принципиально другая модель; говорим об этом здесь,
              чтобы страница не выглядела описанием «хуков вообще». */}
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
