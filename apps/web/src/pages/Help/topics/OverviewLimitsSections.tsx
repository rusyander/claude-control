import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.overview.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Четыре обязательных блока раздела «Обзор»: чем он НЕ является, что читает и
 * пишет, что здесь можно и чего нет, пределы и отказы.
 *
 * Карточка хранения у читающего раздела короче, чем у пишущих, и главная её
 * строка — «ничего не пишет»: обзор единственная страница панели, которая не
 * трогает диск вовсе, и человеку важно знать, что открывать её безопасно.
 */
export function OverviewLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notAnalytics'), description: tr('notAnalyticsText'), isMono: false },
            { name: tr('notSettings'), description: tr('notSettingsText'), isMono: false },
            { name: tr('notSearch'), description: tr('notSearchText'), isMono: false },
            { name: tr('notProjects'), description: tr('notProjectsText'), isMono: false },
            { name: tr('notHistory'), description: tr('notHistoryText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageReads'), value: tr('storageReadsValue'), isMono: true },
            { label: tr('storageOwn'), value: tr('storageOwnValue'), isMono: true },
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
          can={[
            tr('canSee'),
            tr('canPath'),
            tr('canMissing'),
            tr('canBroken'),
            tr('canBackups'),
            tr('canChanges'),
            tr('canJump'),
          ]}
          cant={[tr('cantEdit'), tr('cantDeep'), tr('cantProject'), tr('cantProbe')]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalZero'), description: tr('refusalZeroText'), isMono: false },
            { name: tr('refusalMissing'), description: tr('refusalMissingText'), isMono: false },
            { name: tr('refusalBroken'), description: tr('refusalBrokenText'), isMono: false },
            { name: tr('refusalUnused'), description: tr('refusalUnusedText'), isMono: false },
            { name: tr('refusalMcp'), description: tr('refusalMcpText'), isMono: false },
            { name: tr('refusalCrash'), description: tr('refusalCrashText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
