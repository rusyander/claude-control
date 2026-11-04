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
type GapsTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/** English texts of the actions that closed the agent's capability gaps (lane A, 28.09). */
export const panelTextsGapsEn = {
  'journal-read-chat-modes': 'Chat modes',
  'journal-read-chat-spend': 'Chat spend this session',
  'journal-list-lowered-runs': 'Lowered runs',
  'journal-read-model-pricing': 'Model prices',
  'journal-list-editors': 'Code editors',
  'journal-browse-folders': 'Folder browser',
  'journal-read-claude-access': 'Claude Code account access',
  'journal-list-providers': 'Providers',
  'journal-read-provider-checks': 'Provider check results',
  'journal-jira-transitions': 'Jira issue transitions',
  'journal-portability-fidelity': 'Environment transfer fidelity',
  'journal-read-project-changes': 'Agent edits in a chat',
  'journal-read-worktree-bootstrap-log': 'Working copy install log',
  'journal-read-project-local-config': 'The project’s own .claude',
  'journal-draft-defect': 'Defect draft',
  'journal-list-test-drafts': 'Test drafts',
  'journal-list-default-test-groups': 'Default test groups',
  'journal-request-chat-handoff': 'Asking a chat to close its stage',
  'summary-request-chat-handoff':
    'Ask the agent of chat “{{chat}}” to close the stage and prepare a continuation in a new session',
  'value-handoff-request-standard':
    'The standard request of the “Close stage” button: sum up and prepare the continuation',
  'value-handoff-request-next':
    'The chat’s agent answers with a continuation block; moving to a new session is your call (or the panel agent’s at your request — a separate card)',
  'journal-run-provider-check': 'Provider check',
  'summary-run-provider-check': 'Check provider “{{name}}” on this machine',
  'label-provider-check-model-call': 'Model call',
  'value-provider-check-model-call-on': 'Yes — one short call, spends the subscription limit',
  'value-provider-check-model-call-off': 'No — only the CLI, files and settings',
  'value-provider-check-effect':
    'Writing and reading are checked on a temporary copy; your files do not change, the result is saved as a badge',
  'journal-refresh-defect-states': 'Refreshing defect states',
  'summary-refresh-defect-states':
    'Refresh the defect states of project “{{name}}” from the tracker',
  'label-defects-tracked': 'Defects on cases',
  'value-refresh-defects-effect':
    'The panel reads issue states in the tracker and records them on the cases; nothing changes in the tracker',
  'journal-create-e2e-folder': 'e2e folder',
  'summary-create-e2e-folder': 'Create the e2e folder in project “{{name}}”',
  'value-create-e2e-effect':
    'The panel creates a Playwright e2e/ scaffold hidden from git via .git/info/exclude; the project’s own folder is not touched',
  'journal-remove-e2e-folder': 'Removing the e2e folder',
  'summary-remove-e2e-folder': 'Remove the e2e folder the panel created in project “{{name}}”',
  'value-remove-e2e-effect':
    'The folder is removed whole; if it holds foreign files the panel refuses — only a human may remove them too',
} satisfies GapsTexts;
