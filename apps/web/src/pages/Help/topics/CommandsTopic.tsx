import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { CommandsGuideSections } from './CommandsGuideSections';
import { CommandsLimitsSections } from './CommandsLimitsSections';

/**
 * Документ раздела «Команды».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * собирается список и оба пути в снимках → что уходит на диск → четыре
 * источника и группы → границы, тонкости и разбор «команды не видно».
 *
 * Раньше документ был перечнем возможностей и одной нарисованной схемой:
 * человек читал, ЧТО умеет раздел, и не видел ни одного экрана, пока не
 * открывал панель. Теперь середина — настоящие кадры двух путей, снятые на
 * отдельной панели с временным каталогом настроек, и каждое число в тексте
 * списано со своего кадра.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно: раздел читающий, и его
 * постоянно путают со «Скиллами», «Плагинами» и палитрой «/» в чате — человек,
 * пришедший сюда править команду, не узнает об этом ни из одного снимка.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `CommandsGuideSections` держит схему и оба пути в снимках,
 * `CommandsLimitsSections` — границы, числа, отказы и разбор.
 */
export function CommandsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.commands.${key}`);

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
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyWhose'), text: tr('whyWhoseText') },
            { title: tr('whyJump'), text: tr('whyJumpText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffSkills'), text: tr('diffSkillsText') },
            { title: tr('diffPlugins'), text: tr('diffPluginsText') },
            { title: tr('diffChat'), text: tr('diffChatText') },
          ]}
        />
      </HelpSection>

      <CommandsGuideSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSkills'), value: '~/.claude/skills/<name>/SKILL.md', isMono: true },
            { label: tr('storageFiles'), value: '~/.claude/commands/**/*.md', isMono: true },
            { label: tr('storagePlugins'), value: '~/.claude/plugins/', isMono: true },
            { label: tr('storageBuiltin'), value: tr('storageBuiltinValue') },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
          ]}
        />
      </HelpSection>

      {/* Имя команды складывается из источника, и это единственное, что нужно
          знать, чтобы прочитать любую строку списка. */}
      <HelpSection title={tr('sourcesTitle')}>
        <FieldTable
          caption={tr('sourcesCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: '/skill-name', description: tr('sourceSkill'), badge: tr('badgeSkill') },
            { name: '/folder:name', description: tr('sourceCommand'), badge: tr('badgeCommand') },
            { name: '/plugin:name', description: tr('sourcePlugin'), badge: tr('badgePlugin') },
            {
              name: '/help, /clear, …',
              description: tr('sourceBuiltin'),
              badge: tr('badgeBuiltin'),
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('familyTitle')} caption={tr('familyCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('familyPrefix'), text: tr('familyPrefixText') },
            { title: tr('familyOwner'), text: tr('familyOwnerText') },
          ]}
        />
      </HelpSection>

      <CommandsLimitsSections />
    </>
  );
}
