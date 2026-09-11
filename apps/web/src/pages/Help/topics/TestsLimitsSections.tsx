import { useTranslation } from 'react-i18next';
import { Callout, CapabilityGrid, FieldTable, HelpSection, StepList } from '../ui';

/**
 * Хвост документа «Тесты»: чего раздел не делает и как отыграть назад.
 *
 * Отказы собраны в одну таблицу намеренно. Человек приходит сюда не с вопросом
 * «как устроен карантин», а с фразой «кнопка ничего не сделала», и ответ ему
 * нужен по тексту, который он увидел на экране, — поэтому в левой колонке стоит
 * сам отказ, а не название механизма.
 *
 * «Как отменить» — отдельная секция и стоит последней: пока не сказано, что
 * почти всё отыгрывается, читатель боится нажимать.
 */
export function TestsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitColumn')}
          descriptionHeader={tr('limitMeaningColumn')}
          rows={[
            { name: tr('limitChanged'), description: tr('limitChangedText'), isMono: false },
            { name: tr('limitEmptyRun'), description: tr('limitEmptyRunText'), isMono: false },
            { name: tr('limitMuted'), description: tr('limitMutedText'), isMono: false },
            { name: tr('limitBusy'), description: tr('limitBusyText'), isMono: false },
            { name: tr('limitGenerate'), description: tr('limitGenerateText'), isMono: false },
            { name: tr('limitCoverage'), description: tr('limitCoverageText'), isMono: false },
            { name: tr('limitArchived'), description: tr('limitArchivedText'), isMono: false },
            { name: tr('limitReserved'), description: tr('limitReservedText'), isMono: false },
          ]}
        />
        <Callout tone="warning" title={tr('limitHonestTitle')}>
          {tr('limitHonestText')}
        </Callout>
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canLibrary'),
            tr('canPlans'),
            tr('canManual'),
            tr('canAgent'),
            tr('canDraft'),
            tr('canImport'),
            tr('canDefect'),
            tr('canCoverage'),
            tr('canQuarantine'),
            tr('canRelease'),
            tr('canPhone'),
          ]}
          cant={[tr('cantDatabase'), tr('cantSchedule'), tr('cantMerge'), tr('cantUsers')]}
        />
      </HelpSection>

      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <StepList
          steps={[
            { title: tr('undoQuarantine'), text: tr('undoQuarantineText') },
            { title: tr('undoArchive'), text: tr('undoArchiveText') },
            { title: tr('undoDraft'), text: tr('undoDraftText') },
            { title: tr('undoRun'), text: tr('undoRunText') },
            { title: tr('undoGroup'), text: tr('undoGroupText') },
            { title: tr('undoConvention'), text: tr('undoConventionText') },
          ]}
        />
        <Callout tone="info" title={tr('undoGitTitle')}>
          {tr('undoGitText')}
        </Callout>
      </HelpSection>
    </>
  );
}
