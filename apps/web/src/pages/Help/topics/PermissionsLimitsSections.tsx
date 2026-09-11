import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.permissions.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Три обязательных блока раздела, вынесенные из документа: чем он НЕ является,
 * что правит на диске и пределы с отказами.
 *
 * Стоят они в документе именно в таком порядке и ДО справочных таблиц: первый
 * вопрос человека — «это здесь или в соседнем разделе», второй — «куда это
 * запишется», и только третий — «почему не сработало». Ограничения в конце
 * мелким шрифтом читают уже после того, как обожглись.
 */
export function PermissionsLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notRules'), description: tr('notRulesText'), isMono: false },
            { name: tr('notGroups'), description: tr('notGroupsText'), isMono: false },
            { name: tr('notProjects'), description: tr('notProjectsText'), isMono: false },
            { name: tr('notMcp'), description: tr('notMcpText'), isMono: false },
            { name: tr('notSettings'), description: tr('notSettingsText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title="settings.json"
          rows={[
            { label: tr('storageFile'), value: tr('storageFileValue'), isMono: true },
            { label: tr('storageLocal'), value: tr('storageLocalValue'), isMono: true },
            { label: tr('storageId'), value: tr('storageIdValue') },
            { label: tr('storageMove'), value: tr('storageMoveValue') },
            { label: tr('storageOff'), value: tr('storageOffValue') },
            { label: tr('storageWhen'), value: tr('storageWhenValue') },
            { label: tr('storageOs'), value: tr('storageOsValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canThree'),
            tr('canPattern'),
            tr('canPreset'),
            tr('canBulk'),
            tr('canMcp'),
            tr('canMove'),
            tr('canToggle'),
            tr('canSee'),
            tr('canShadow'),
            tr('canValidate'),
            tr('canAssistant'),
          ]}
          cant={[
            tr('cantWhy'),
            tr('cantProject'),
            tr('cantOrderCustom'),
            tr('cantRestart'),
            tr('cantUndo'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalShadow'), description: tr('refusalShadowText'), isMono: false },
            { name: tr('refusalUnknown'), description: tr('refusalUnknownText'), isMono: false },
            { name: tr('refusalNotSet'), description: tr('refusalNotSetText'), isMono: false },
            { name: tr('refusalRestart'), description: tr('refusalRestartText'), isMono: false },
            { name: tr('refusalDeleted'), description: tr('refusalDeletedText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
