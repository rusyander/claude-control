import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.analytics.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки раздела «Аналитика»: чем он НЕ является, что читает и пишет,
 * что умеет и чего нет, пределы и отказы.
 *
 * Строка «что пишет» здесь не пустая, в отличие от обзора и поиска: журнал
 * понижений — единственный файл, который раздел действительно ведёт, и человеку
 * важно знать, что всё остальное он только читает.
 */
export function AnalyticsLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notBill'), description: tr('notBillText'), isMono: false },
            { name: tr('notLimits'), description: tr('notLimitsText'), isMono: false },
            { name: tr('notChat'), description: tr('notChatText'), isMono: false },
            { name: tr('notRegistry'), description: tr('notRegistryText'), isMono: false },
            { name: tr('notHistory'), description: tr('notHistoryText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSource'), value: tr('storageSourceValue'), isMono: true },
            { label: tr('storageWhat'), value: tr('storageWhatValue') },
            { label: tr('storageSkills'), value: tr('storageSkillsValue') },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
            { label: tr('storageCache'), value: tr('storageCacheValue') },
            { label: tr('storageClaude'), value: tr('storageClaudeValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canPeriod'),
            tr('canDetail'),
            tr('canLive'),
            tr('canTools'),
            tr('canSessions'),
            tr('canExport'),
          ]}
          cant={[tr('cantLimits'), tr('cantBill'), tr('cantOther'), tr('cantRealtime')]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            { name: tr('limitCache'), description: tr('limitCacheText'), isMono: false },
            { name: tr('limitOld'), description: tr('limitOldText'), isMono: false },
            { name: tr('limitSessions'), description: tr('limitSessionsText'), isMono: false },
            { name: tr('limitProject'), description: tr('limitProjectText'), isMono: false },
            { name: tr('limitLive'), description: tr('limitLiveText'), isMono: false },
            { name: tr('limitPrice'), description: tr('limitPriceText'), isMono: false },
            { name: tr('limitDir'), description: tr('limitDirText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
