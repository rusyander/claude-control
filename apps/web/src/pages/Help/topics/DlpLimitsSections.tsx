import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.dlp.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки документа «Защита данных»: чем раздел НЕ является, что он
 * пишет на диске и чего не пишет никогда, пределы и отказы с кодами ответов.
 *
 * Строка «чего на диске нет никогда» стоит в той же карточке, что и файлы, а не
 * отдельной оговоркой: вопрос «а где тогда лежит соответствие метки значению»
 * возникает ровно при чтении перечня файлов.
 */
export function DlpLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notDlpSuite'), description: tr('notDlpSuiteText'), isMono: false },
            { name: tr('notSmart'), description: tr('notSmartText'), isMono: false },
            { name: tr('notTls'), description: tr('notTlsText'), isMono: false },
            { name: tr('notAudit'), description: tr('notAuditText'), isMono: false },
            { name: tr('notGateProxy'), description: tr('notGateProxyText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageRules'), value: tr('storageRulesValue'), isMono: true },
            { label: tr('storageJournalFile'), value: tr('storageJournalValue'), isMono: true },
            { label: tr('storageSettingsRow'), value: tr('storageSettingsValue'), isMono: true },
            { label: tr('storageHook'), value: tr('storageHookValue'), isMono: true },
            { label: tr('storageNever'), value: tr('storageNeverValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canProxy'),
            tr('canMask'),
            tr('canRestore'),
            tr('canBlockReq'),
            tr('canPreviewText'),
            tr('canGate'),
          ]}
          cant={[
            tr('cantUnderstand'),
            tr('cantForeignTraffic'),
            tr('cantGateForeign'),
            tr('cantGateReplace'),
            tr('cantRestoreLog'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalBlocked'), description: tr('refusalBlockedText'), isMono: false },
            { name: tr('refusalUnknown'), description: tr('refusalUnknownText'), isMono: false },
            { name: tr('refusalTooBig'), description: tr('refusalTooBigText'), isMono: false },
            {
              name: tr('refusalUpstream'),
              description: tr('refusalUpstreamText'),
              isMono: false,
            },
            {
              name: tr('refusalGateProvider'),
              description: tr('refusalGateProviderText'),
              isMono: false,
            },
            {
              name: tr('refusalGateUnsure'),
              description: tr('refusalGateUnsureText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
