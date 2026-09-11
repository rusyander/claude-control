import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.integrations.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки документа «Интеграции»: чем вкладка НЕ является, что она
 * пишет на диске, пределы и отказы дословно.
 *
 * Отказы здесь стоят таблицей, а не рассказом: у этой вкладки они читаются
 * похоже («не подключена», «токен не сохранён», 404, 401), а значат разное —
 * выключенную карточку, отсутствие ключа, перепутанный диалект и чужой токен.
 */
export function IntegrationsLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notSync'), description: tr('notSyncText'), isMono: false },
            { name: tr('notAuto'), description: tr('notAutoText'), isMono: false },
            { name: tr('notAgentKey'), description: tr('notAgentKeyText'), isMono: false },
            { name: tr('notDelete'), description: tr('notDeleteText'), isMono: false },
            { name: tr('notBlocker'), description: tr('notBlockerText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSettings'), value: tr('storageSettingsValue'), isMono: true },
            { label: tr('storageTokens'), value: tr('storageTokensValue'), isMono: true },
            { label: tr('storageHealth'), value: tr('storageHealthValue'), isMono: true },
            { label: tr('storageLinks'), value: tr('storageLinksValue'), isMono: true },
            { label: tr('storageMcp'), value: tr('storageMcpValue'), isMono: true },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canCheck'),
            tr('canDetect'),
            tr('canMcp'),
            tr('canNotify'),
            tr('canSign'),
            tr('canForget'),
          ]}
          cant={[
            tr('cantSso'),
            tr('cantDelete'),
            tr('cantBackground'),
            tr('cantSendBody'),
            tr('cantAddBot'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            {
              name: tr('refusalNotConnected'),
              description: tr('refusalNotConnectedText'),
              isMono: false,
            },
            { name: tr('refusalNoToken'), description: tr('refusalNoTokenText'), isMono: false },
            {
              name: tr('refusalNoBaseUrl'),
              description: tr('refusalNoBaseUrlText'),
              isMono: false,
            },
            {
              name: tr('refusalWrongDialect'),
              description: tr('refusalWrongDialectText'),
              isMono: false,
            },
            {
              name: tr('refusalForge401'),
              description: tr('refusalForge401Text'),
              isMono: false,
            },
            {
              name: tr('refusalTelegramChat'),
              description: tr('refusalTelegramChatText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
