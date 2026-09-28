import type {
  PanelPluralForm,
  PanelTextCode,
  PanelTextCountCode,
} from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и
 * обратный импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту
 * держит тип `PanelTextDictionary` у места вливания.
 */
type TestsTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/** English texts of the agent's Testing-block actions, merged into `panelTextsEn` by one spread. */
export const panelTextsTestsEn = {
  'journal-read-tests-report': 'Testing report',
  'journal-save-test-plan': 'Saving a test plan',
  'summary-save-test-plan-create': 'Create test plan “{{title}}”',
  'summary-save-test-plan-update': 'Edit test plan “{{title}}”',
  'journal-delete-test-plan': 'Deleting a test plan',
  'summary-delete-test-plan': 'Delete test plan “{{title}}” (its runs stay in the history)',
  'journal-build-test-plan': 'Building a test plan by a rule',
  'summary-build-test-plan_one': 'Save plan “{{title}}”: {{count}} case picked by the rule',
  'summary-build-test-plan_other': 'Save plan “{{title}}”: {{count}} cases picked by the rule',
  'label-plan-recipe': 'Selection rule',
  'value-plan-recipe-smoke': 'smoke within a time budget',
  'value-plan-recipe-diff': 'regression by working-copy changes',
  'value-plan-recipe-release': 'milestone plan',
  'value-plan-recipe-flaky': 'flaky cases',
  'journal-start-manual-run': 'Starting a manual run',
  'summary-start-manual-run_one': 'Start a manual run: {{count}} pass',
  'summary-start-manual-run_other': 'Start a manual run: {{count}} passes',
  'journal-record-manual-result': 'Marking a manual pass',
  'summary-record-manual-result': 'Mark “{{title}}”: {{status}}',
  'journal-finish-manual-run': 'Finishing a manual run',
  'summary-finish-manual-run': 'Finish the manual run: {{done}} of {{total}} marked',
  'journal-cancel-manual-run': 'Cancelling a manual run',
  'summary-cancel-manual-run':
    'Abandon the manual run: {{done}} of {{total}} marked, the marks stay',
  'journal-attach-test-note': 'Attachment to a case',
  'summary-attach-test-note': 'Attach “{{name}}” to case “{{title}}”',
  'journal-accept-baseline': 'Accepting a baseline',
  'summary-accept-baseline': 'Accept the latest snapshot as the baseline of case “{{title}}”',
  'label-baseline-diff': 'Difference from the baseline',
  'value-baseline-replace':
    'The previous baseline is replaced by the latest snapshot; the panel cannot bring it back',
  'journal-sync-e2e': 'Syncing autotests with cases',
  'summary-sync-e2e': 'Sync the tests of folder {{dir}} with the cases',
  'journal-run-e2e': 'Running autotests',
  'summary-run-e2e-all': 'Run all autotests of the project',
  'summary-run-e2e-some_one': 'Run the autotest of {{count}} case',
  'summary-run-e2e-some_other': 'Run the autotests of {{count}} cases',
  'value-e2e-run-happens':
    'The autotest command runs on this machine, without an agent; the result goes to the run history',
  'journal-stop-e2e': 'Stopping autotests',
  'summary-stop-e2e': 'Stop the running autotest run',
  'journal-save-shared-step': 'Saving a shared step',
  'summary-save-shared-step-create': 'Create shared step “{{title}}”',
  'summary-save-shared-step-update': 'Edit shared step “{{title}}”',
  'journal-delete-shared-step': 'Deleting a shared step',
  'summary-delete-shared-step': 'Delete shared step “{{title}}”',
  'journal-save-test-environment': 'Saving a test environment',
  'summary-save-test-environment-create': 'Create environment “{{title}}”',
  'summary-save-test-environment-update': 'Edit environment “{{title}}”',
  'journal-delete-test-environment': 'Deleting a test environment',
  'summary-delete-test-environment': 'Delete environment “{{title}}”',
  'label-used-by-plans': 'Plans referring to it',
  'value-environment-secrets-go': 'The stand credentials saved in the panel are deleted with it',
  'journal-save-test-schema': 'Saving custom fields and statuses',
  'summary-save-test-schema': 'Replace the project’s custom case fields and statuses',
  'journal-save-test-view': 'Saving a saved filter',
  'summary-save-test-view-create': 'Save filter “{{title}}”',
  'summary-save-test-view-update': 'Edit filter “{{title}}”',
  'journal-delete-test-view': 'Deleting a saved filter',
  'summary-delete-test-view': 'Delete filter “{{title}}”',
  'journal-install-test-convention': 'Case convention in the project instructions',
  'summary-install-test-convention': 'Add the case convention to the project instructions',
  'value-convention-install':
    'The convention block is appended to the project’s instructions file (CLAUDE.md or ' +
    'AGENTS.md — whichever the project already uses); the previous file is kept as a backup',
  'journal-bulk-edit-cases': 'Bulk case edit',
  'summary-bulk-edit-cases_one': 'Change {{count}} case at once',
  'summary-bulk-edit-cases_other': 'Change {{count}} cases at once',
  'label-bulk-action': 'What to do',
  'journal-bulk-delete-cases': 'Bulk case deletion',
  'summary-bulk-delete-cases_one': 'Delete {{count}} case',
  'summary-bulk-delete-cases_other': 'Delete {{count}} cases',
  'journal-draft-auto-accept': 'Accepting drafts at once',
  'summary-draft-auto-accept-on': 'Accept generation drafts at once, without review',
  'summary-draft-auto-accept-off': 'Generation drafts wait for human review again',
  'journal-rollback-draft': 'Undoing a draft acceptance',
  'summary-rollback-draft_one':
    'Undo the draft acceptance: {{count}} case returns to its previous state',
  'summary-rollback-draft_other':
    'Undo the draft acceptance: {{count}} cases return to their previous state',
} satisfies TestsTexts;
