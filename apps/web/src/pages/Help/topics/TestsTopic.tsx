import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Callout, FieldTable, HelpSection, OptionCards, StorageCard } from '../ui';
import { TestsGuideSections } from './TestsGuideSections';
import { TestsManualSections } from './TestsManualSections';
import { TestsSetupSection } from './TestsSetupSection';
import { TestsHealthSections } from './TestsHealthSections';
import { TestsExchangeSections } from './TestsExchangeSections';
import { TestsLimitsSections } from './TestsLimitsSections';
import { TestsNotesSection } from './TestsNotesSection';

/**
 * Документ раздела «Тесты» — рабочее место тестировщика целиком.
 *
 * Пишется для человека, который пришёл из TMS и ищет привычные слова:
 * библиотека, чек-лист, общий шаг, тест-план, окружение, прогон, отчёт, дефект.
 *
 * Порядок — общий для всей справки: зачем это нужно → чем отличается от
 * соседнего → весь путь шагами со снимками → таблицы полей и состояний → что
 * этим ведут (библиотека, планы, прогоны, отчёт) → ограничения и отказы → как
 * отменить и убрать. Раньше он был «тема за темой», и человек, впервые
 * открывший раздел, доходил до слова «прогон» на третьем экране, ни разу не
 * увидев экрана.
 *
 * Снимки и схемы живут в `TestsGuideSections` — это не отдельный документ и
 * больше им не будет: две страницы означают два оглавления и вопрос «это я уже
 * читал?» на каждом переходе.
 */
export function TestsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <>
      {/* Страница длинная, и первое, что ей нужно сказать, — из чего она
          состоит: иначе человек, которому нужен один факт, листает наугад. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyFiles'), text: tr('whyFilesText') },
            { title: tr('whyBoth'), text: tr('whyBothText') },
            { title: tr('whyOne'), text: tr('whyOneText') },
          ]}
        />
      </HelpSection>

      {/* Соседей у раздела четверо, и с каждым его путают по-своему. Пока не
          сказано, чем он им не является, половина вопросов к нему — про то,
          чего он никогда не делал. */}
      <HelpSection title={tr('vsTitle')} caption={tr('vsCaption')}>
        <OptionCards
          minWidth={280}
          items={[
            { title: tr('vsTms'), text: tr('vsTmsText') },
            { title: tr('vsChat'), text: tr('vsChatText') },
            { title: tr('vsCi'), text: tr('vsCiText') },
            { title: tr('vsProjects'), text: tr('vsProjectsText') },
          ]}
        />
      </HelpSection>

      <TestsGuideSections />

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

      {/* Состояния — отдельная таблица, потому что их читают с экрана: в строке
          кейса рядом стоят статус, готовность, автоматизация и карантин, и это
          четыре независимых отметки, а не одна шкала. */}
      <HelpSection title={tr('statesTitle')} caption={tr('statesCaption')}>
        <FieldTable
          nameHeader={tr('stateColumn')}
          descriptionHeader={tr('stateMeaningColumn')}
          rows={[
            { name: tr('stateNotRun'), description: tr('stateNotRunText'), isMono: false },
            { name: tr('stateRunning'), description: tr('stateRunningText'), isMono: false },
            { name: tr('statePassed'), description: tr('statePassedText'), isMono: false },
            { name: tr('stateFailed'), description: tr('stateFailedText'), isMono: false },
            { name: tr('stateSkipped'), description: tr('stateSkippedText'), isMono: false },
            { name: tr('stateBlocked'), description: tr('stateBlockedText'), isMono: false },
            { name: tr('stateDraft'), description: tr('stateDraftText'), isMono: false },
            { name: tr('stateReady'), description: tr('stateReadyText'), isMono: false },
            { name: tr('stateStale'), description: tr('stateStaleText'), isMono: false },
            { name: tr('stateManual'), description: tr('stateManualText'), isMono: false },
            { name: tr('stateToAutomate'), description: tr('stateToAutomateText'), isMono: false },
            { name: tr('stateAuto'), description: tr('stateAutoText'), isMono: false },
            { name: tr('stateMuted'), description: tr('stateMutedText'), isMono: false },
            { name: tr('stateArchived'), description: tr('stateArchivedText'), isMono: false },
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

      <TestsHealthSections />

      <TestsExchangeSections />

      <TestsLimitsSections />

      <TestsNotesSection />
    </>
  );
}
