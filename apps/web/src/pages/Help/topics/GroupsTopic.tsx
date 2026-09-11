import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { GroupsGuideSections } from './GroupsGuideSections';
import { GroupsLimitsSections } from './GroupsLimitsSections';

/**
 * Документ раздела «Группы».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * устроено и оба пути в снимках → привязка и старшинство тумблеров → что уходит
 * на диск → поля → границы, тонкости и отмена.
 *
 * Два блока стоят между снимками и хранением намеренно. «Привязка к проекту» —
 * единственная автоматика раздела, и в момент срабатывания на экране не
 * происходит ничего: группа просто оказывается включённой, снять это кадром
 * нечем. «Кто кого перебивает» отвечает на самый частый вопрос раздела —
 * «включаю, а оно не включается», — и ответ у него не в состоянии экрана, а в
 * двух независимых отметках выключения.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `GroupsGuideSections` держит схемы и оба пути в снимках,
 * `GroupsLimitsSections` — границы, числа, тонкости и отмену.
 */
export function GroupsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.groups.${key}`);

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
            { title: tr('whyEnv'), text: tr('whyEnvText') },
            { title: tr('whyBundle'), text: tr('whyBundleText') },
            { title: tr('whySimple'), text: tr('whySimpleText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffClaude'), text: tr('diffClaudeText') },
            { title: tr('diffCopy'), text: tr('diffCopyText') },
            { title: tr('diffMagic'), text: tr('diffMagicText') },
            { title: tr('diffAuto'), text: tr('diffAutoText') },
          ]}
        />
      </HelpSection>

      <GroupsGuideSections tr={tr} />

      {/* Автоматического включения не видно ни на одном экране: в этот момент
          человек смотрит в чат, а не в раздел. Поэтому — словами. */}
      <HelpSection title={tr('bindTitle')} caption={tr('bindCaption')}>
        <OptionCards
          items={[
            { title: tr('bindProject'), text: tr('bindProjectText') },
            { title: tr('bindWorktree'), text: tr('bindWorktreeText') },
            { title: tr('bindNoOff'), text: tr('bindNoOffText') },
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

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('storageTitle')}
          rows={[
            {
              label: tr('storageWhere'),
              value: '~/.claude/agentdeck/state.json',
              isMono: true,
            },
            { label: tr('storageEnv'), value: '~/.claude/settings.json → env', isMono: true },
            {
              label: tr('storageSkill'),
              value: '~/.claude/skills/scenario-<название>/',
              isMono: true,
            },
            {
              label: tr('storageHooks'),
              value: '~/.claude/settings.json → hooks',
              isMono: true,
            },
            { label: tr('storageMarker'), value: tr('storageMarkerValue') },
            { label: tr('storageDisabled'), value: tr('storageDisabledValue') },
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
            { name: 'projectPaths', description: tr('fieldProjectPaths') },
            { name: 'scenario.steps', description: tr('fieldSteps') },
            { name: 'scenario.trigger', description: tr('fieldScenarioTrigger') },
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

      <GroupsLimitsSections />
    </>
  );
}
