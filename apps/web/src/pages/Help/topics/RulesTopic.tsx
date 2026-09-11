import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { RulesGuideSections } from './RulesGuideSections';
import { RulesLimitsSections } from './RulesLimitsSections';

/**
 * Документ раздела «Правила».
 *
 * Порядок тот же, что у «Чата»: зачем это нужно → чем это НЕ является → как
 * устроено и весь путь в снимках → что уходит на диск → формат и поля →
 * границы, тонкости и отмена.
 *
 * Раньше документ был перечнем возможностей и двумя нарисованными схемами:
 * человек читал, ЧТО умеет раздел, и не видел ни одного экрана, пока не
 * открывал панель. Теперь середина — настоящие кадры двух путей, снятые на
 * отдельной панели с временным каталогом настроек, и каждый шаг назван
 * значениями из своего кадра.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно: правила путают с правами,
 * скиллами, хуками и проектным CLAUDE.md, и человек, попавший не в тот раздел,
 * не узнает об этом ни из одного снимка.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `RulesGuideSections` держит схемы и оба пути в снимках, `RulesLimitsSections`
 * — границы, числа, отказы и отмену.
 */
export function RulesTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.rules.${key}`);

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
            { title: tr('whyRepeat'), text: tr('whyRepeatText') },
            { title: tr('whyEverywhere'), text: tr('whyEverywhereText') },
            { title: tr('whyVisible'), text: tr('whyVisibleText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffPermissions'), text: tr('diffPermissionsText') },
            { title: tr('diffProject'), text: tr('diffProjectText') },
            { title: tr('diffSkills'), text: tr('diffSkillsText') },
            { title: tr('diffHooks'), text: tr('diffHooksText') },
          ]}
        />
      </HelpSection>

      <RulesGuideSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="CLAUDE.md"
          rows={[
            { label: tr('storageFile'), value: '~/.claude/CLAUDE.md', isMono: true },
            { label: tr('storageUnit'), value: tr('storageUnitValue') },
            { label: tr('storageDisabled'), value: tr('storageDisabledValue') },
            { label: tr('storageReader'), value: tr('storageReaderValue') },
            { label: tr('storageMarks'), value: tr('storageMarksValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/agentdeck/backups/',
              isMono: true,
            },
          ]}
        />
      </HelpSection>

      {/* Формат заголовка — контракт панели (contracts/rule-format). Ровно на
          него опирается объясняющая заглушка «0 правил» на странице раздела, и
          сюда она ведёт ссылкой. */}
      <HelpSection title={tr('formatTitle')} caption={tr('formatCaption')}>
        <OptionCards
          items={[
            { title: tr('formatRule'), text: tr('formatRuleText') },
            { title: tr('formatPlain'), text: tr('formatPlainText') },
          ]}
        />
        <Callout tone="info" title={tr('formatZero')}>
          {tr('formatZeroText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('modesTitle')} caption={tr('modesCaption')}>
        <OptionCards
          items={[
            { title: tr('modeSimple'), text: tr('modeSimpleText') },
            { title: tr('modeBuilder'), text: tr('modeBuilderText') },
            { title: tr('modeBulk'), text: tr('modeBulkText') },
          ]}
        />
        <Callout tone="info" title={tr('modesNote')} />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'title',
              description: tr('fieldTitle'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'body',
              description: tr('fieldBody'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'isEnabled', description: tr('fieldEnabled') },
            { name: 'groupIds', description: tr('fieldGroups') },
          ]}
        />
      </HelpSection>

      <RulesLimitsSections />
    </>
  );
}
