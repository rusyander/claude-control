import { HelpSection, StorageCard, FieldTable, CapabilityGrid, TopicCard } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.settings.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
  /** Название и краткое описание раздела «Контур» — ссылка ведёт в его документ. */
  platform: { title: string; summary: string };
}

/**
 * Обязательные блоки раздела «Настройки»: чем он НЕ является, что пишет на
 * диске, что умеет и чего не умеет, отказы с причинами.
 *
 * Вкладка «Контур» живёт на этой же странице, но разбирается своим документом,
 * и здесь стоит СКОЛЬКО-ТО подробного пересказа: карточка-ссылка. Сокращённый
 * пересказ чужой модели доступа хуже, чем его отсутствие, — он устаревает молча.
 */
export function SettingsLimitsSections({ tr, common, platform }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notProviders'), description: tr('notProvidersText'), isMono: false },
            { name: tr('notEnv'), description: tr('notEnvText'), isMono: false },
            { name: tr('notDlp'), description: tr('notDlpText'), isMono: false },
            { name: tr('notHistory'), description: tr('notHistoryText'), isMono: false },
            { name: tr('notPlatform'), description: tr('notPlatformText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('platformLinkTitle')} caption={tr('platformLinkCaption')}>
        <TopicCard
          topicId="platform"
          icon="flag"
          title={platform.title}
          summary={platform.summary}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageApp'), value: tr('storageAppValue') },
            { label: tr('storageManual'), value: tr('storageManualValue'), isMono: true },
            { label: tr('storageBackups'), value: tr('storageBackupsValue'), isMono: true },
            { label: tr('storageApply'), value: tr('storageApplyValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canPath'),
            tr('canCreds'),
            tr('canEditor'),
            tr('canTheme'),
            tr('canSpendUnit'),
            tr('canBackup'),
            tr('canEncrypt'),
            tr('canRevertHunk'),
            tr('canTransfer'),
            tr('canEnvTransfer'),
            tr('canModels'),
            tr('canCheck'),
            tr('canPreview'),
            tr('canWatch'),
          ]}
          cant={[tr('cantLogin'), tr('cantToken'), tr('cantChange'), tr('cantSync')]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalDir'), description: tr('refusalDirText'), isMono: false },
            {
              name: tr('refusalPassphrase'),
              description: tr('refusalPassphraseText'),
              isMono: false,
            },
            {
              name: tr('refusalSecretBackup'),
              description: tr('refusalSecretBackupText'),
              isMono: false,
            },
            { name: tr('refusalOrigin'), description: tr('refusalOriginText'), isMono: false },
            { name: tr('refusalToken'), description: tr('refusalTokenText'), isMono: false },
            { name: tr('refusalRestart'), description: tr('refusalRestartText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
