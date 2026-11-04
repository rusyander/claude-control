import { useTranslation } from 'react-i18next';
import { HelpSection, StorageCard, Callout, OptionCards } from '../../ui';
import { GroupsGuideSections } from '../GroupsGuideSections/GroupsGuideSections';
import { GroupsLimitsSections } from '../GroupsLimitsSections/GroupsLimitsSections';

/**
 * Документ раздела «Группы» (этап 10): работу ведёт ядро, прежние группы — только для чтения.
 *
 * Порядок: что изменилось → страница в кадрах → что не переносится в ядро → где лежат данные.
 * «Что изменилось» стоит первым намеренно: читатель приходит с привычкой прежнего раздела
 * (создать, включить, запустить группу) и должен сразу узнать, что этих действий больше нет.
 *
 * `GroupsGuideSections` держит три кадра страницы, `GroupsLimitsSections` — что ядро от
 * прежней группы не берёт.
 */
export function GroupsTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.groups.${key}`);

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={tr('whatTitle')} caption={tr('whatCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('whatCore'), text: tr('whatCoreText') },
            { title: tr('whatReadOnly'), text: tr('whatReadOnlyText') },
            { title: tr('whatImport'), text: tr('whatImportText') },
            { title: tr('whatRuns'), text: tr('whatRunsText') },
          ]}
        />
      </HelpSection>

      <GroupsGuideSections tr={tr} />

      <GroupsLimitsSections tr={tr} />

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('storageTitle')}
          rows={[
            {
              label: tr('storageGroups'),
              value: '~/.claude/agentdeck/state.json → groups',
              isMono: true,
            },
            {
              label: tr('storageRuns'),
              value: '~/.claude/agentdeck/state.json → splitPlans',
              isMono: true,
            },
            { label: tr('storageScenarios'), value: tr('storageScenariosValue') },
          ]}
        />
      </HelpSection>
    </>
  );
}
