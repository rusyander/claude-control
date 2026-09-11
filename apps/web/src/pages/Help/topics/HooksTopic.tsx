import { useTranslation } from 'react-i18next';
import { HOOK_EVENT_INFO } from '@agentdeck/contracts';
import { HelpSection, StorageCard, FieldTable, StepList, Callout, OptionCards } from '../ui';
import { HooksGuideSections } from './HooksGuideSections';
import { HooksLimitsSections } from './HooksLimitsSections';

/**
 * Документ раздела «Хуки».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * устроено и весь путь в снимках → что уходит на диск → события, шаблоны,
 * пресеты, поля → границы, тонкости и отмена.
 *
 * Таблица событий строится из HOOK_EVENT_INFO: список событий, поддержку
 * фильтра и способность блокировать берём из контракта, чтобы справка не
 * разошлась с формой. Тексты при этом свои — в контракте они только на русском.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно: хук путают с правилом,
 * скиллом и правом, а человек, которому на самом деле нужно правило, не узнает
 * об этом ни из одного снимка.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `HooksGuideSections` держит две схемы и оба пути в снимках,
 * `HooksLimitsSections` — границы, числа, отказы и отмену.
 */
export function HooksTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.hooks.${key}`);

  return (
    <>
      {/* Страница длинная, и первое, что ей нужно сказать, — из чего она
          состоит: иначе человек, которому нужен один факт, листает наугад. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyGuarantee'), text: tr('whyGuaranteeText') },
            { title: tr('whyBlock'), text: tr('whyBlockText') },
            { title: tr('whyAutomate'), text: tr('whyAutomateText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffRule'), text: tr('diffRuleText') },
            { title: tr('diffSkill'), text: tr('diffSkillText') },
            { title: tr('diffPermission'), text: tr('diffPermissionText') },
          ]}
        />
      </HelpSection>

      <HooksGuideSections tr={tr} />

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

      <HooksLimitsSections />
    </>
  );
}
