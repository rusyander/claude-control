import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.providers.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки документа «Провайдеры»: чем раздел НЕ является, что панель
 * пишет о провайдере у СЕБЯ, что умеет и чего не умеет, отказы с причинами.
 *
 * Карточка хранения здесь отдельная и намеренно отделена от списка файлов
 * каждого CLI ниже по документу: там чужие файлы, которые панель правит, здесь
 * — служебные файлы самой панели, которые она правит всегда и молча.
 */
export function ProvidersLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notInstall'), description: tr('notInstallText'), isMono: false },
            { name: tr('notModels'), description: tr('notModelsText'), isMono: false },
            { name: tr('notMigrate'), description: tr('notMigrateText'), isMono: false },
            {
              name: tr('notPlatformHere'),
              description: tr('notPlatformHereText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('ownStorageTitle')} caption={tr('ownStorageCaption')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageActive'), value: tr('storageActiveValue'), isMono: true },
            { label: tr('storageChecks'), value: tr('storageChecksValue'), isMono: true },
            { label: tr('storageKeys'), value: tr('storageKeysValue'), isMono: true },
            {
              label: tr('storageFormatCache'),
              value: tr('storageFormatCacheValue'),
              isMono: true,
            },
            { label: tr('storageNever'), value: tr('storageNeverValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canSwitch'),
            tr('canWriteForeign'),
            tr('canProbe'),
            tr('canKey'),
            tr('canFormats'),
            tr('canFallback'),
          ]}
          cant={[
            tr('cantInstallCli'),
            tr('cantMigrateConfig'),
            tr('cantWriteStub'),
            tr('cantRestoreForeign'),
            tr('cantInventSchema'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalNoCli'), description: tr('refusalNoCliText'), isMono: false },
            {
              name: tr('refusalStubSection'),
              description: tr('refusalStubSectionText'),
              isMono: false,
            },
            { name: tr('refusalNoApi'), description: tr('refusalNoApiText'), isMono: false },
            {
              name: tr('refusalKeyLength'),
              description: tr('refusalKeyLengthText'),
              isMono: false,
            },
            {
              name: tr('refusalNoSchema'),
              description: tr('refusalNoSchemaText'),
              isMono: false,
            },
            {
              name: tr('refusalRestoreForeign'),
              description: tr('refusalRestoreForeignText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
