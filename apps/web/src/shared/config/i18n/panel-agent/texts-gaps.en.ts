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
  'journal-read-model-cascade': 'Model picked per task',
  'journal-list-lowered-runs': 'Lowered runs',
  'journal-read-split-overlap': 'Split branch overlaps',
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
  'journal-set-model-cascade': 'Model picked per task',
  'summary-set-model-cascade-on': 'Turn on picking the model per task in project “{{name}}”',
  'summary-set-model-cascade-off': 'Turn off picking the model per task in project “{{name}}”',
  'value-model-cascade-on':
    'The next chat runs of this project (and its copies) pick the model for the kind of work themselves',
  'value-model-cascade-off':
    'The next chat runs of this project (and its copies) use the model you chose',
  'journal-split-accept-group': 'Accepting a split group',
  'summary-split-accept': 'Accept the delivered group “{{group}}” of chat “{{chat}}”’s split',
  'summary-split-unaccept':
    'Remove the “accepted” mark from group “{{group}}” of chat “{{chat}}”’s split',
  'value-split-accept-effect':
    'The group is marked “accepted” in the split plan; its branch, copy and chat stay as they are',
  'value-split-unaccept-effect':
    'The “accepted” mark is removed; the group’s branch, copy and chat stay as they are',
  'journal-split-resume-interrupted': 'Resuming interrupted split groups',
  'summary-split-resume-interrupted': 'Resume the interrupted split groups of chat “{{chat}}”',
  'label-split-interrupted-groups': 'Interrupted groups',
  'value-split-resume-interrupted-effect':
    'Each group resumes in its own session with its state restored; the turn spends the subscription limit',
  'journal-run-provider-check': 'Provider check',
  'summary-run-provider-check': 'Check provider “{{name}}” on this machine',
  'label-provider-check-model-call': 'Model call',
  'value-provider-check-model-call-on': 'Yes — one short call, spends the subscription limit',
  'value-provider-check-model-call-off': 'No — only the CLI, files and settings',
  'value-provider-check-effect':
    'Writing and reading are checked on a temporary copy; your files do not change, the result is saved as a badge',
  'journal-summarize-resource': 'Short resource description',
  'summary-summarize-resource': 'Describe “{{name}}” briefly',
  'label-resource-kind': 'Resource kind',
  'value-summarize-resource-effect':
    'If there is no description yet, the panel makes one cheap model call (spends the limit) and remembers the answer',
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
