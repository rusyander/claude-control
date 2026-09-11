import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.search.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки раздела «Поиск»: чем он НЕ является, что читает и пишет, что
 * умеет и чего нет, пределы и отказы.
 *
 * Карточка хранения короткая по той же причине, что у обзора: поиск ничего не
 * пишет. Зато строка «что читает» здесь важнее — человеку нужно знать, что файл
 * секретов и хранилище ключей не открываются вовсе, а не «показываются
 * замаскированными».
 */
export function SearchLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notChat'), description: tr('notChatText'), isMono: false },
            { name: tr('notFiles'), description: tr('notFilesText'), isMono: false },
            { name: tr('notOverview'), description: tr('notOverviewText'), isMono: false },
            { name: tr('notSection'), description: tr('notSectionText'), isMono: false },
            { name: tr('notCommands'), description: tr('notCommandsText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageWhere'), value: tr('storageWhereValue') },
            { label: tr('storageScope'), value: tr('storageScopeValue') },
            { label: tr('storageNever'), value: tr('storageNeverValue'), isMono: true },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
            { label: tr('storageWhen'), value: tr('storageWhenValue') },
            { label: tr('storageClaude'), value: tr('storageClaudeValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[tr('canAll'), tr('canGrouped'), tr('canOpen'), tr('canLive'), tr('canTests')]}
          cant={[tr('cantBody'), tr('cantSecrets'), tr('cantEdit'), tr('cantRegex')]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            { name: tr('limitShort'), description: tr('limitShortText'), isMono: false },
            { name: tr('limitEmpty'), description: tr('limitEmptyText'), isMono: false },
            { name: tr('limitEnv'), description: tr('limitEnvText'), isMono: false },
            { name: tr('limitProvider'), description: tr('limitProviderText'), isMono: false },
            { name: tr('limitBroken'), description: tr('limitBrokenText'), isMono: false },
            { name: tr('limitPlugins'), description: tr('limitPluginsText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
