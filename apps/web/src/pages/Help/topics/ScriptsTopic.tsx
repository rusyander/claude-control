import { useTranslation } from 'react-i18next';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, StepList, Callout, OptionCards } from '../ui';
import { ScriptsGuideSections } from './ScriptsGuideSections';
import { ScriptsLimitsSections } from './ScriptsLimitsSections';

/**
 * Документ раздела «Скрипты».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * считается привязка и весь путь в снимках → что уходит на диск → контракт со
 * stdin/stdout, каркасы, поля → границы, тонкости и отмена.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно: «Скрипты» и «Хуки» —
 * две стороны одного действия, и человек, пришедший сюда настраивать событие,
 * не узнает об этом ни из одного снимка.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `ScriptsGuideSections` держит схему привязки и оба пути в снимках,
 * `ScriptsLimitsSections` — границы, числа, отказы и отмену.
 */
export function ScriptsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.scripts.${key}`);

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
            { title: tr('whyEdit'), text: tr('whyEditText') },
            { title: tr('whyOrphans'), text: tr('whyOrphansText') },
            { title: tr('whyTest'), text: tr('whyTestText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffHook'), text: tr('diffHookText') },
            { title: tr('diffScript'), text: tr('diffScriptText') },
            { title: tr('diffBoth'), text: tr('diffBothText') },
          ]}
        />
      </HelpSection>

      <ScriptsGuideSections tr={tr} />

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

      {/* Контракт со средой: событие приходит потоком и ответ уходит потоком.
          Без этой пары шагов код скрипта неоткуда начать писать. */}
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
            { name: 'path', description: tr('fieldPath') },
            { name: 'isUsed', description: tr('fieldIsUsed') },
            { name: 'size', description: tr('fieldSize') },
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

      <ScriptsLimitsSections />
    </>
  );
}
