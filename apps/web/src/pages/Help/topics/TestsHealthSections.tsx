import { useTranslation } from 'react-i18next';
import { Callout, HelpSection, OptionCards } from '../ui';

/**
 * Разделы документа «Тесты» про набор, который уже живёт: покрытие, карантин,
 * устаревание, риск и готовность релиза.
 *
 * Вынесены из `TestsTopic` одним куском — это ровно те пять тем, которые
 * разбирает второй сценарий снимков, и держать их рядом дешевле, чем искать по
 * документу. Файлом отдельно по той же причине, что и соседи: документ упирается
 * в предел длины.
 */
export function TestsHealthSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      {/* Единственный вид, отвечающий на «что мы вообще не проверяем»: список
          кейсов отвечает на обратный вопрос, и дыру по нему не видно. */}
      <HelpSection title={tr('coverageTitle')} caption={tr('coverageCaption')}>
        <OptionCards
          items={[
            { title: tr('coverageLinks'), text: tr('coverageLinksText') },
            { title: tr('coverageJira'), text: tr('coverageJiraText') },
            { title: tr('coverageOrder'), text: tr('coverageOrderText') },
            { title: tr('coverageOrphans'), text: tr('coverageOrphansText') },
          ]}
        />
        <Callout tone="info" title={tr('coverageArchivedTitle')}>
          {tr('coverageArchivedText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('quarantineTitle')} caption={tr('quarantineCaption')}>
        <OptionCards
          items={[
            { title: tr('quarantineWhat'), text: tr('quarantineWhatText') },
            { title: tr('quarantineReason'), text: tr('quarantineReasonText') },
            { title: tr('quarantineCi'), text: tr('quarantineCiText') },
            { title: tr('quarantineFilter'), text: tr('quarantineFilterText') },
          ]}
        />
        <Callout tone="warning" title={tr('quarantineNotArchiveTitle')}>
          {tr('quarantineNotArchiveText')}
        </Callout>
      </HelpSection>

      {/* Карантин и устаревание — единственное место, где сказано, по каким
          числам панель предлагает выключить кейс и вернуть его в строй. */}
      <HelpSection title={tr('ageingTitle')} caption={tr('ageingCaption')}>
        <OptionCards
          items={[
            { title: tr('ageingLift'), text: tr('ageingLiftText') },
            { title: tr('ageingMute'), text: tr('ageingMuteText') },
            { title: tr('ageingStale'), text: tr('ageingStaleText') },
            { title: tr('ageingNotRun'), text: tr('ageingNotRunText') },
          ]}
        />
        <Callout tone="warning" title={tr('ageingManualTitle')}>
          {tr('ageingManualText')}
        </Callout>
      </HelpSection>

      {/* Риск — единственное место, где написана формула: пять множителей и
          почему ни один из них не обнуляется. Без неё порядок «по риску»
          читается как мнение панели, а он счётный. */}
      <HelpSection title={tr('riskTitle')} caption={tr('riskCaption')}>
        <OptionCards
          items={[
            { title: tr('riskPriority'), text: tr('riskPriorityText') },
            { title: tr('riskOutcome'), text: tr('riskOutcomeText') },
            { title: tr('riskInstability'), text: tr('riskInstabilityText') },
            { title: tr('riskAge'), text: tr('riskAgeText') },
            { title: tr('riskImpact'), text: tr('riskImpactText') },
          ]}
        />
        <Callout tone="info" title={tr('riskBudgetTitle')}>
          {tr('riskBudgetText')}
        </Callout>
        <Callout tone="warning" title={tr('riskUnknownTitle')}>
          {tr('riskUnknownText')}
        </Callout>
      </HelpSection>

      {/* Готовность релиза — единственное место, где сказано, что вердикт
          означает и чего он НЕ означает: панель ничего не подписывает. */}
      <HelpSection title={tr('releaseTitle')} caption={tr('releaseCaption')}>
        <OptionCards
          items={[
            { title: tr('releaseSet'), text: tr('releaseSetText') },
            { title: tr('releaseTag'), text: tr('releaseTagText') },
            { title: tr('releaseUntested'), text: tr('releaseUntestedText') },
            { title: tr('releaseDoc'), text: tr('releaseDocText') },
          ]}
        />
        <Callout tone="warning" title={tr('releaseVerdictTitle')}>
          {tr('releaseVerdictText')}
        </Callout>
        <Callout tone="info" title={tr('releasePrintTitle')}>
          {tr('releasePrintText')}
        </Callout>
      </HelpSection>
    </>
  );
}
