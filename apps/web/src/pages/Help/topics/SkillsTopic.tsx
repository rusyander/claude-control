import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { SkillsGuideSections } from './SkillsGuideSections';
import { SkillsLimitsSections } from './SkillsLimitsSections';

/**
 * Документ раздела «Скиллы».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * устроено и весь путь в снимках → что уходит на диск → описание и структура →
 * поля → границы, тонкости и отмена.
 *
 * Раньше документ был перечнем возможностей и двумя нарисованными схемами:
 * человек читал, ЧТО умеет раздел, и не видел ни одного экрана, пока не
 * открывал панель. Теперь середина — настоящие кадры двух путей, снятые на
 * отдельной панели с временным каталогом настроек, и каждый шаг назван
 * значениями из своего кадра.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно: скиллы путают с правилами,
 * разделом «Команды», скиллами плагина и проектными скиллами, и человек,
 * попавший не в тот раздел, не узнает об этом ни из одного снимка.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `SkillsGuideSections` держит схемы и оба пути в снимках,
 * `SkillsLimitsSections` — границы, числа, отказы и отмену.
 */
export function SkillsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.skills.${key}`);

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
            { title: tr('whyOnDemand'), text: tr('whyOnDemandText') },
            { title: tr('whyProcess'), text: tr('whyProcessText') },
            { title: tr('whyPortable'), text: tr('whyPortableText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffRules'), text: tr('diffRulesText') },
            { title: tr('diffCommands'), text: tr('diffCommandsText') },
            { title: tr('diffPlugins'), text: tr('diffPluginsText') },
            { title: tr('diffProject'), text: tr('diffProjectText') },
          ]}
        />
      </HelpSection>

      <SkillsGuideSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageFolder'), value: '~/.claude/skills/<name>/', isMono: true },
            { label: tr('storageMain'), value: tr('storageMainValue') },
            { label: tr('storageDisabled'), value: '~/.claude/skills-disabled/', isMono: true },
            { label: tr('storageOff'), value: tr('storageOffValue') },
            { label: tr('storageMarks'), value: tr('storageMarksValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/agentdeck/backups/',
              isMono: true,
            },
          ]}
        />
      </HelpSection>

      {/* Описание — единственное поле, от которого зависит, подключится скилл
          или нет. Оно стоит сразу после диска и перед всем остальным. */}
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

      <SkillsLimitsSections />
    </>
  );
}
