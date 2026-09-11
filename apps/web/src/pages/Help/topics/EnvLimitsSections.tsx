import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.env.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Четыре обязательных блока раздела «Переменные»: чем он НЕ является, что
 * пишет на диске, пределы и отказы.
 *
 * Карточка хранения здесь длиннее, чем у соседей, и это не избыточность: три
 * файла с разными читателями — ровно то, ради чего человек открывает эту
 * справку, и держать их в одном месте дешевле, чем собирать по абзацам.
 */
export function EnvLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notMcp'), description: tr('notMcpText'), isMono: false },
            { name: tr('notSettings'), description: tr('notSettingsText'), isMono: false },
            { name: tr('notGroups'), description: tr('notGroupsText'), isMono: false },
            { name: tr('notProjects'), description: tr('notProjectsText'), isMono: false },
            { name: tr('notSecurity'), description: tr('notSecurityText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSettings'), value: tr('storageSettingsValue'), isMono: true },
            { label: tr('storageLocal'), value: tr('storageLocalValue'), isMono: true },
            { label: tr('storageSecrets'), value: tr('storageSecretsValue'), isMono: true },
            { label: tr('storageWhoReads'), value: tr('storageWhoReadsValue') },
            { label: tr('storageDetect'), value: tr('storageDetectValue') },
            { label: tr('storageComments'), value: tr('storageCommentsValue') },
            { label: tr('storageBackup'), value: tr('storageBackupValue') },
            { label: tr('storageWhen'), value: tr('storageWhenValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canTwo'),
            tr('canAuto'),
            tr('canSubstitute'),
            tr('canReveal'),
            tr('canBulkAdd'),
            tr('canComment'),
            tr('canAssistant'),
            tr('canMove'),
          ]}
          cant={[
            tr('cantEdit'),
            tr('cantEncrypt'),
            tr('cantMoveSecret'),
            tr('cantGroupEdit'),
            tr('cantScope'),
            tr('cantSee'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            {
              name: tr('refusalMultiline'),
              description: tr('refusalMultilineText'),
              isMono: false,
            },
            {
              name: tr('refusalSecretEdit'),
              description: tr('refusalSecretEditText'),
              isMono: false,
            },
            { name: tr('refusalGroup'), description: tr('refusalGroupText'), isMono: false },
            {
              name: tr('refusalMoveSecret'),
              description: tr('refusalMoveSecretText'),
              isMono: false,
            },
            {
              name: tr('refusalNotApplied'),
              description: tr('refusalNotAppliedText'),
              isMono: false,
            },
            {
              name: tr('refusalUnknownVar'),
              description: tr('refusalUnknownVarText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
