import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.history.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки раздела «История изменений»: чем он НЕ является, что читает
 * и пишет, что умеет и чего нет, пределы и отказы.
 *
 * Строка «что пишет» здесь самая важная: раздел читающий ровно до того момента,
 * пока не нажат возврат блока, — и тогда он пишет в РАБОЧИЙ файл конфигурации,
 * предварительно сняв копию. Человек должен знать это до клика, а не после.
 */
export function HistoryLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notGit'), description: tr('notGitText'), isMono: false },
            { name: tr('notRestore'), description: tr('notRestoreText'), isMono: false },
            { name: tr('notChat'), description: tr('notChatText'), isMono: false },
            { name: tr('notProject'), description: tr('notProjectText'), isMono: false },
            { name: tr('notAudit'), description: tr('notAuditText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            {
              label: tr('storageSource'),
              value: '~/.claude/agentdeck/backups/',
              isMono: true,
            },
            { label: tr('storageTracked'), value: tr('storageTrackedValue') },
            { label: tr('storageSecrets'), value: tr('storageSecretsValue'), isMono: true },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
            { label: tr('storageRotation'), value: tr('storageRotationValue') },
            { label: tr('storageClaude'), value: tr('storageClaudeValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canFeed'),
            tr('canDiff'),
            tr('canCounts'),
            tr('canRevertHunk'),
            tr('canOffline'),
          ]}
          cant={[tr('cantSecrets'), tr('cantWhole'), tr('cantProvider'), tr('cantBig')]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            { name: tr('limitFirst'), description: tr('limitFirstText'), isMono: false },
            { name: tr('limitSame'), description: tr('limitSameText'), isMono: false },
            { name: tr('limitProvider'), description: tr('limitProviderText'), isMono: false },
            { name: tr('limitBig'), description: tr('limitBigText'), isMono: false },
            { name: tr('limitMissing'), description: tr('limitMissingText'), isMono: false },
            { name: tr('limitRotation'), description: tr('limitRotationText'), isMono: false },
            { name: tr('limitOff'), description: tr('limitOffText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
