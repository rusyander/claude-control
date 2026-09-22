import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.portability.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки раздела «Паспорт среды»: чем он НЕ является, что читает и
 * пишет, что умеет и чего нет, пять уровней верности, пределы и отказы.
 *
 * Две строки карточки хранения здесь самые важные. «Что пишет» — потому что
 * раздел читающий ровно до нажатия переноса или пересборки, и тогда пишет в
 * ЧУЖИЕ файлы. «Канон подписки» — потому что провайдер сверху выбирается, а
 * канон нет, и перепутать их значит ждать пересборки не из того источника.
 */
export function PortabilityLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notInstall'), description: tr('notInstallText'), isMono: false },
            { name: tr('notCompare'), description: tr('notCompareText'), isMono: false },
            { name: tr('notHistory'), description: tr('notHistoryText'), isMono: false },
            { name: tr('notMerge'), description: tr('notMergeText'), isMono: false },
            { name: tr('notLineMerge'), description: tr('notLineMergeText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageReads'), value: tr('storageReadsValue') },
            { label: tr('storageCanon'), value: tr('storageCanonValue') },
            { label: tr('storageWrites'), value: tr('storageWritesValue') },
            { label: tr('storageState'), value: tr('storageStateValue') },
            { label: tr('storageSecrets'), value: tr('storageSecretsValue') },
            { label: tr('storageTarget'), value: tr('storageTargetValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canPassport'),
            tr('canFidelity'),
            tr('canPlan'),
            tr('canRevert'),
            tr('canSubscribe'),
            tr('canDrift'),
            tr('canProbe'),
          ]}
          cant={[
            tr('cantInstall'),
            tr('cantSecretValue'),
            tr('cantMerge'),
            tr('cantTranscripts'),
            tr('cantSilent'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('levelsTitle')} caption={tr('levelsCaption')}>
        <FieldTable
          nameHeader={tr('levelsColumn')}
          descriptionHeader={tr('levelsMeaningColumn')}
          rows={[
            { name: tr('levelNative'), description: tr('levelNativeText'), isMono: false },
            { name: tr('levelEmulated'), description: tr('levelEmulatedText'), isMono: false },
            { name: tr('levelWired'), description: tr('levelWiredText'), isMono: false },
            { name: tr('levelText'), description: tr('levelTextText'), isMono: false },
            { name: tr('levelImpossible'), description: tr('levelImpossibleText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            { name: tr('limitRuntime'), description: tr('limitRuntimeText'), isMono: false },
            { name: tr('limitCollision'), description: tr('limitCollisionText'), isMono: false },
            { name: tr('limitChanged'), description: tr('limitChangedText'), isMono: false },
            { name: tr('limitHeld'), description: tr('limitHeldText'), isMono: false },
            {
              name: tr('limitCanonVersion'),
              description: tr('limitCanonVersionText'),
              isMono: false,
            },
            { name: tr('limitNewForever'), description: tr('limitNewForeverText'), isMono: false },
            { name: tr('limitNoCli'), description: tr('limitNoCliText'), isMono: false },
            {
              name: tr('limitProjectLevel'),
              description: tr('limitProjectLevelText'),
              isMono: false,
            },
          ]}
        />
      </HelpSection>
    </>
  );
}
