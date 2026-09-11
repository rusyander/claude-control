import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.compare.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки раздела «Сравнение конфигураций»: чем он НЕ является, что
 * читает и пишет, что умеет и чего нет, пределы и отказы.
 *
 * Таблица отказов здесь длиннее, чем у соседей, и это не многословие: перенос
 * пишет в файл чужого CLI, поэтому каждый отказ обязан быть назван заранее — на
 * экране он появляется в тот момент, когда человек уже нацелился на кнопку.
 */
export function CompareLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notSync'), description: tr('notSyncText'), isMono: false },
            { name: tr('notFileDiff'), description: tr('notFileDiffText'), isMono: false },
            { name: tr('notSwitch'), description: tr('notSwitchText'), isMono: false },
            { name: tr('notProject'), description: tr('notProjectText'), isMono: false },
            { name: tr('notHistory'), description: tr('notHistoryText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageReads'), value: tr('storageReadsValue') },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
            { label: tr('storageNever'), value: tr('storageNeverValue') },
            { label: tr('storageBackup'), value: tr('storageBackupValue') },
            { label: tr('storageClaude'), value: tr('storageClaudeValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canCompare'),
            tr('canMcp'),
            tr('canInstructions'),
            tr('canPreview'),
            tr('canSwap'),
          ]}
          cant={[tr('cantEnv'), tr('cantPermissions'), tr('cantDisabled'), tr('cantMerge')]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            { name: tr('limitDisabled'), description: tr('limitDisabledText'), isMono: false },
            { name: tr('limitSse'), description: tr('limitSseText'), isMono: false },
            { name: tr('limitEnv'), description: tr('limitEnvText'), isMono: false },
            { name: tr('limitPerm'), description: tr('limitPermText'), isMono: false },
            {
              name: tr('limitUnsupported'),
              description: tr('limitUnsupportedText'),
              isMono: false,
            },
            { name: tr('limitSame'), description: tr('limitSameText'), isMono: false },
            { name: tr('limitSkipped'), description: tr('limitSkippedText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
