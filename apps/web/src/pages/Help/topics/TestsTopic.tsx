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

      <HelpSection title={tr('manualTitle')} caption={tr('manualCaption')}>
        <StepList
          steps={[
            { title: tr('manualStep1'), text: tr('manualStep1Text') },
            { title: tr('manualStep2'), text: tr('manualStep2Text') },
            { title: tr('manualStep3'), text: tr('manualStep3Text') },
            { title: tr('manualStep4'), text: tr('manualStep4Text') },
            { title: tr('manualStep5'), text: tr('manualStep5Text') },
          ]}
        />
        <Callout tone="info" title={tr('manualPhoneTitle')}>
          {tr('manualPhoneText')}
        </Callout>
      </HelpSection>

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

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canLibrary'),
            tr('canPlans'),
            tr('canManual'),
            tr('canAgent'),
            tr('canImport'),
            tr('canDefect'),
            tr('canPhone'),
          ]}
          cant={[tr('cantDatabase'), tr('cantSchedule'), tr('cantMerge'), tr('cantUsers')]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteBrokenTitle')}>
            {tr('noteBrokenText')}
          </Callout>
          <Callout tone="info" title={tr('noteStatusTitle')}>
            {tr('noteStatusText')}
          </Callout>
          <Callout tone="info" title={tr('noteHumanTitle')}>
            {tr('noteHumanText')}
          </Callout>
          <Callout tone="info" title={tr('noteGitTitle')}>
            {tr('noteGitText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
