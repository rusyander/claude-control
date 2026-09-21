import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, FieldTable, Callout, OptionCards } from '../ui';
import { ProjectsGuideSections } from './ProjectsGuideSections';
import { ProjectsLimitsSections } from './ProjectsLimitsSections';

/**
 * Документ раздела «Проекты».
 *
 * Порядок тот же, что у «Правил»: зачем это нужно → чем это НЕ является → как
 * устроено и оба пути в снимках → что уходит на диск → поля → границы, тонкости
 * и отмена.
 *
 * Блок «Чем это НЕ является» стоит вторым намеренно. Проектный уровень путают с
 * пользовательским (те же формы, другой файл), вкладку «Из проекта» — с
 * редактором, а сохранение — с безопасной панельной настройкой, хотя оно правит
 * рабочее дерево чужого репозитория. Ни одну из этих ошибок снимок не
 * опровергает: экран в них выглядит ровно так, как человек и ожидает.
 *
 * Соседние файлы — не «вынесенные куски», а разделы со своей работой:
 * `ProjectsGuideSections` держит схемы и оба пути в снимках,
 * `ProjectsLimitsSections` — границы, числа, тонкости и отмену.
 */
export function ProjectsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.projects.${key}`);

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
            { title: tr('whyLevel'), text: tr('whyLevelText') },
            { title: tr('whyAdditive'), text: tr('whyAdditiveText') },
            { title: tr('whySame'), text: tr('whySameText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('diffUser'), text: tr('diffUserText') },
            { title: tr('diffLocal'), text: tr('diffLocalText') },
            { title: tr('diffGroups'), text: tr('diffGroupsText') },
            { title: tr('diffGit'), text: tr('diffGitText') },
          ]}
        />
      </HelpSection>

      <ProjectsGuideSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="<проект>/"
          rows={[
            {
              label: tr('storageRegistry'),
              value: '~/.claude/agentdeck/state.json',
              isMono: true,
            },
            {
              label: tr('storageRules'),
              // П2.7: проект без своего `CLAUDE.md` живёт на `AGENTS.md` — панель
              // правит тот файл, который читает CLI, и второго не заводит.
              value: '<проект>/CLAUDE.md · <проект>/AGENTS.md',
              isMono: true,
            },
            { label: tr('storageMcp'), value: '<проект>/.mcp.json', isMono: true },
            {
              label: tr('storagePerms'),
              value: '<проект>/.claude/settings.json · settings.local.json',
              isMono: true,
            },
            { label: tr('storageLocal'), value: tr('storageLocalValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/agentdeck/backups/project-<id>-<файл>',
              isMono: true,
            },
            { label: tr('storageCreate'), value: tr('storageCreateValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'path',
              description: tr('fieldPath'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'name', description: tr('fieldName') },
          ]}
        />
      </HelpSection>

      <ProjectsLimitsSections />
    </>
  );
}
