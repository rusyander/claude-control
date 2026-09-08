import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import {
  Callout,
  CapabilityGrid,
  FieldTable,
  HelpSection,
  OptionCards,
  StepList,
  StorageCard,
} from '../ui';
import { TestsManualSections } from './TestsManualSections';
import { TestsSetupSection } from './TestsSetupSection';
import { TestsNotesSection } from './TestsNotesSection';

/**
 * Документ раздела «Тесты» — рабочее место тестировщика целиком.
 *
 * Пишется для человека, который пришёл из TMS и ищет привычные слова:
 * библиотека, чек-лист, общий шаг, тест-план, окружение, прогон, отчёт, дефект.
 * Поэтому порядок здесь не «как устроено», а «как этим работают»: сначала где
 * живут кейсы, потом как их вести, чем гонять и куда смотреть после.
 */
export function TestsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyFiles'), text: tr('whyFilesText') },
            { title: tr('whyBoth'), text: tr('whyBothText') },
            { title: tr('whyOne'), text: tr('whyOneText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')} caption={tr('storageCaption')}>
        <StorageCard
          title={tr('title')}
          rows={[
            {
              label: tr('storageGroup'),
              value: '<проект>/.agent/tests/<группа>.tests.json',
              isMono: true,
            },
            { label: tr('storageShared'), value: '.agent/tests/_shared.steps.json', isMono: true },
            {
              label: tr('storageEnvironments'),
              value: '.agent/tests/environments.json',
              isMono: true,
            },
            { label: tr('storageSchema'), value: '.agent/tests/schema.json', isMono: true },
            { label: tr('storageViews'), value: '.agent/tests/views.json', isMono: true },
            { label: tr('storagePlans'), value: '.agent/tests/plans/<id>.plan.json', isMono: true },
            { label: tr('storageRuns'), value: '.agent/tests/runs/<id>.run.json', isMono: true },
            {
              label: tr('storageAttachments'),
              value: '.agent/tests/attachments/<кейс>/',
              isMono: true,
            },
            { label: tr('storageVersions'), value: tr('storageVersionsValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('libraryTitle')} caption={tr('libraryCaption')}>
        <OptionCards
          minWidth={280}
          items={[
            { title: tr('libraryGroups'), text: tr('libraryGroupsText') },
            { title: tr('librarySections'), text: tr('librarySectionsText') },
            { title: tr('libraryCase'), text: tr('libraryCaseText') },
            { title: tr('libraryChecklist'), text: tr('libraryChecklistText') },
            { title: tr('librarySharedSteps'), text: tr('librarySharedStepsText') },
            { title: tr('libraryParameters'), text: tr('libraryParametersText') },
            { title: tr('libraryAttributes'), text: tr('libraryAttributesText') },
            { title: tr('libraryTags'), text: tr('libraryTagsText') },
          ]}
        />
      </HelpSection>

      <TestsSetupSection />

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          caption={tr('fieldsCaption')}
          rows={[
            {
              name: 'title',
              description: tr('fieldTitle'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'type', description: tr('fieldType') },
            { name: 'purpose', description: tr('fieldPurpose') },
            { name: 'area / section', description: tr('fieldArea') },
            { name: 'precondition', description: tr('fieldPrecondition') },
            { name: 'steps[].action / expected / data', description: tr('fieldSteps') },
            { name: 'expected', description: tr('fieldExpected') },
            { name: 'postcondition', description: tr('fieldPostcondition') },
            { name: 'oracle', description: tr('fieldOracle') },
            { name: 'priority', description: tr('fieldPriority') },
            { name: 'readiness', description: tr('fieldReadiness') },
            { name: 'duration', description: tr('fieldDuration') },
            { name: 'tags', description: tr('fieldTags') },
            { name: 'links', description: tr('fieldLinks') },
            { name: 'parameters', description: tr('fieldParameters') },
            { name: 'automation', description: tr('fieldAutomation') },
            { name: 'automation.externalId', description: tr('fieldExternalId') },
            { name: 'muted / muteReason', description: tr('fieldMuted') },
            { name: 'defects', description: tr('fieldDefects') },
            { name: 'codePaths', description: tr('fieldCodePaths') },
            { name: 'status / note / lastRunAt', description: tr('fieldStatus') },
            { name: 'source', description: tr('fieldSource') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('plansTitle')} caption={tr('plansCaption')}>
        <OptionCards
          items={[
            { title: tr('plansStatic'), text: tr('plansStaticText') },
            { title: tr('plansDynamic'), text: tr('plansDynamicText') },
            { title: tr('plansEnvironments'), text: tr('plansEnvironmentsText') },
            { title: tr('plansPoints'), text: tr('plansPointsText') },
          ]}
        />
        <Callout tone="info" title={tr('plansLockedTitle')}>
          {tr('plansLockedText')}
        </Callout>
      </HelpSection>

      <TestsManualSections />

      <HelpSection title={tr('agentTitle')} caption={tr('agentCaption')}>
        <OptionCards
          minWidth={280}
          items={[
            { title: tr('agentGenerate'), text: tr('agentGenerateText') },
            { title: tr('agentRun'), text: tr('agentRunText') },
            { title: tr('agentExplore'), text: tr('agentExploreText') },
            { title: tr('agentAutomate'), text: tr('agentAutomateText') },
          ]}
        />
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('agentAccessTitle')}>
            {tr('agentAccessText')}
          </Callout>
          <Callout tone="info" title={tr('agentChangedTitle')}>
            {tr('agentChangedText')}
          </Callout>
          <Callout tone="info" title={tr('agentConventionTitle')}>
            {tr('agentConventionText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Источник — это не пятый режим прогона, а другое чтение той же
          генерации, и путают их постоянно: кнопок четыре, а в истории все
          четыре записи называются «генерация». */}
      <HelpSection title={tr('sourceTitle')} caption={tr('sourceCaption')}>
        <OptionCards
          minWidth={280}
          items={[
            { title: tr('sourceCode'), text: tr('sourceCodeText') },
            { title: tr('sourceRequirement'), text: tr('sourceRequirementText') },
            { title: tr('sourceDiff'), text: tr('sourceDiffText') },
            { title: tr('sourceDefect'), text: tr('sourceDefectText') },
          ]}
        />
        <Callout tone="warning" title={tr('sourceRefusedTitle')}>
          {tr('sourceRefusedText')}
        </Callout>
      </HelpSection>

      {/* Отдельной секцией, а не карточкой у генерации: человек приходит сюда с
          вопросом «куда делись кейсы, которые агент придумал», и ответ на него —
          весь путь от черновика до отката, а не одна строка про кнопку. */}
      <HelpSection title={tr('draftTitle')} caption={tr('draftCaption')}>
        <OptionCards
          minWidth={280}
          items={[
            { title: tr('draftFile'), text: tr('draftFileText') },
            { title: tr('draftPick'), text: tr('draftPickText') },
            { title: tr('draftSimilar'), text: tr('draftSimilarText') },
            { title: tr('draftUndo'), text: tr('draftUndoText') },
            { title: tr('draftAuto'), text: tr('draftAutoText') },
          ]}
        />
        <Callout tone="warning" title={tr('draftRightsTitle')}>
          {tr('draftRightsText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('runsTitle')} caption={tr('runsCaption')}>
        <FieldTable
          nameHeader={tr('runsColumn')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('runsSummary'), description: tr('runsSummaryText'), isMono: false },
            { name: tr('runsCoverage'), description: tr('runsCoverageText'), isMono: false },
            { name: tr('runsFlaky'), description: tr('runsFlakyText'), isMono: false },
            { name: tr('runsSpend'), description: tr('runsSpendText'), isMono: false },
            { name: tr('runsSession'), description: tr('runsSessionText'), isMono: false },
          ]}
        />
      </HelpSection>

      {/* Провал без доказательства чинить нечем: это единственное место, где
          сказано, что панель требует и чего НЕ отменяет. */}
      <HelpSection title={tr('evidenceTitle')} caption={tr('evidenceCaption')}>
        <OptionCards
          items={[
            { title: tr('evidenceWhat'), text: tr('evidenceWhatText') },
            { title: tr('evidenceRetry'), text: tr('evidenceRetryText') },
            { title: tr('evidenceReport'), text: tr('evidenceReportText') },
            { title: tr('evidenceDefect'), text: tr('evidenceDefectText') },
          ]}
        />
        <Callout tone="info" title={tr('evidenceKeepTitle')}>
          {tr('evidenceKeepText')}
        </Callout>
      </HelpSection>

      {/* Сравнение — единственное место, отвечающее на «что сломалось с прошлого
          раза»: сводка прогона отвечает на «сколько красного сейчас». */}
      <HelpSection title={tr('diffTitle')} caption={tr('diffCaption')}>
        <OptionCards
          items={[
            { title: tr('diffLists'), text: tr('diffListsText') },
            { title: tr('diffPrevious'), text: tr('diffPreviousText') },
            { title: tr('diffRerun'), text: tr('diffRerunText') },
            { title: tr('diffRecheck'), text: tr('diffRecheckText') },
          ]}
        />
        <Callout tone="warning" title={tr('diffComparableTitle')}>
          {tr('diffComparableText')}
        </Callout>
      </HelpSection>

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

      {/* Доступы стенда — единственное место, где сказано, ГДЕ лежит пароль и
          почему его не видно обратно: без этого его ищут в файле проекта. */}
      <HelpSection title={tr('secretsTitle')} caption={tr('secretsCaption')}>
        <OptionCards
          items={[
            { title: tr('secretsWhere'), text: tr('secretsWhereText') },
            { title: tr('secretsSplit'), text: tr('secretsSplitText') },
            { title: tr('secretsRun'), text: tr('secretsRunText') },
            { title: tr('secretsMissing'), text: tr('secretsMissingText') },
          ]}
        />
        <Callout tone="info" title={tr('secretsShowTitle')}>
          {tr('secretsShowText')}
        </Callout>
        <Callout tone="warning" title={tr('secretsReservedTitle')}>
          {tr('secretsReservedText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('importTitle')} caption={tr('importCaption')}>
        <OptionCards
          items={[
            { title: tr('importResults'), text: tr('importResultsText') },
            { title: tr('importCases'), text: tr('importCasesText') },
            { title: tr('importExport'), text: tr('importExportText') },
          ]}
        />
        <Callout tone="warning" title={tr('importMatchTitle')}>
          {tr('importMatchText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('defectsTitle')} caption={tr('defectsCaption')}>
        <StepList
          steps={[
            { title: tr('defectStep1'), text: tr('defectStep1Text') },
            { title: tr('defectStep2'), text: tr('defectStep2Text') },
            { title: tr('defectStep3'), text: tr('defectStep3Text') },
          ]}
        />
      </HelpSection>

      {/* Терминальный вход стоит СРАЗУ после импорта из CI: человек, который
          дочитал до «результаты приходят из CI», следующим вопросом спрашивает,
          как в том же CI позвать линтер, сравнение и сборку плана. */}
      <HelpSection title={tr('cliTitle')} caption={tr('cliCaption')}>
        <OptionCards
          items={[
            { title: tr('cliLint'), text: tr('cliLintText') },
            { title: tr('cliDiff'), text: tr('cliDiffText') },
            { title: tr('cliPlan'), text: tr('cliPlanText') },
          ]}
        />
      </HelpSection>

      {/* Что раздел умеет ТОЛЬКО с настроенными интеграциями. Подробности —
          отдельный документ; здесь достаточно знать, что эти кнопки есть и
          откуда они берутся, иначе их ищут в разделе и не находят. */}
      <HelpSection title={tr('externalTitle')} caption={tr('externalCaption')}>
        <OptionCards
          items={[
            { title: tr('externalDefect'), text: tr('externalDefectText') },
            { title: tr('externalDefectState'), text: tr('externalDefectStateText') },
            { title: tr('externalPublish'), text: tr('externalPublishText') },
            { title: tr('externalPdf'), text: tr('externalPdfText') },
            { title: tr('externalBaseline'), text: tr('externalBaselineText') },
          ]}
        />
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

      <TestsNotesSection />
    </>
  );
}
