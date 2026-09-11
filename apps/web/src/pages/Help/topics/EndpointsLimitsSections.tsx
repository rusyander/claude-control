import { HelpSection, StorageCard, FieldTable, CapabilityGrid } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.endpoints.<key>`. */
  tr: (key: string) => string;
  /** Общий ключ справки: `help.common.<key>`. */
  common: (key: string) => string;
}

/**
 * Обязательные блоки документа «Свой эндпоинт»: чем он НЕ является, что пишет на
 * диске и когда это увидит CLI, пределы и отказы дословно.
 *
 * Строка «Когда это увидит CLI» стоит в карточке хранения, а не в тонкостях:
 * «записали, а не работает» — самая частая жалоба раздела, и ответ на неё должен
 * лежать рядом с перечнем файлов, а не в конце документа.
 */
export function EndpointsLimitsSections({ tr, common }: SectionProps) {
  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[
            { name: tr('notProxy'), description: tr('notProxyText'), isMono: false },
            { name: tr('notMask'), description: tr('notMaskText'), isMono: false },
            { name: tr('notRunner'), description: tr('notRunnerText'), isMono: false },
            { name: tr('notEnvSection'), description: tr('notEnvSectionText'), isMono: false },
            { name: tr('notContour'), description: tr('notContourText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageProfiles'), value: tr('storageProfilesValue'), isMono: true },
            { label: tr('storageToken'), value: tr('storageTokenValue'), isMono: true },
            { label: tr('storageApplied'), value: tr('storageAppliedValue') },
            { label: tr('storageSeen'), value: tr('storageSeenValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${common('canTitle')} · ${common('cantTitle')}`}>
        <CapabilityGrid
          canTitle={common('canTitle')}
          cantTitle={common('cantTitle')}
          can={[
            tr('canProfile'),
            tr('canProbe'),
            tr('canPreview'),
            tr('canApply'),
            tr('canToken'),
            tr('canAssistant'),
          ]}
          cant={[
            tr('cantForce'),
            tr('cantSecret'),
            tr('cantRestart'),
            tr('cantHide'),
            tr('cantVerifyModel'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <FieldTable
          nameHeader={tr('refusalsColumn')}
          descriptionHeader={tr('refusalsMeaningColumn')}
          rows={[
            { name: tr('refusalUrl'), description: tr('refusalUrlText'), isMono: false },
            { name: tr('refusalHttps'), description: tr('refusalHttpsText'), isMono: false },
            { name: tr('refusalNoVar'), description: tr('refusalNoVarText'), isMono: false },
            { name: tr('refusalNoEnv'), description: tr('refusalNoEnvText'), isMono: false },
            {
              name: tr('refusalKindMismatch'),
              description: tr('refusalKindMismatchText'),
              isMono: false,
            },
            { name: tr('refusalNotJson'), description: tr('refusalNotJsonText'), isMono: false },
            { name: tr('refusalStatus'), description: tr('refusalStatusText'), isMono: false },
          ]}
        />
      </HelpSection>
    </>
  );
}
