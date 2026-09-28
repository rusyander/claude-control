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
type ProjectTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/** English texts of the agent's project actions, merged into `panelTextsEn` by one spread. */
export const panelTextsProjectsEn = {
  'journal-project-claude-md-read': 'Project instructions file',
  'journal-project-mcp-list': 'Project MCP servers',
  'journal-project-permissions-list': 'Project permissions',
  'journal-project-group-choice': 'Which group is active in a project',
  'journal-project-copy-settings': 'Project copy and split settings',
  'journal-project-runner': 'Project dev servers',
  'journal-project-files': 'Project files',
  'journal-project-file-read': 'Reading a project file',
  'journal-project-claude-md-save': 'Editing the project instructions file',
  'summary-project-claude-md-save': 'Replace the whole instructions file of project “{{project}}”',
  'journal-project-mcp-save': 'Editing a project MCP server',
  'summary-project-mcp-add': 'Add MCP server “{{name}}” to project “{{project}}”',
  'summary-project-mcp-edit': 'Edit MCP server “{{name}}” of project “{{project}}”',
  'journal-project-mcp-delete': 'Deleting a project MCP server',
  'summary-project-mcp-delete': 'Delete MCP server “{{name}}” from project “{{project}}”',
  'journal-project-mcp-toggle': 'Turning a project MCP server on or off',
  'summary-project-mcp-enable': 'Turn on MCP server “{{name}}” in project “{{project}}”',
  'summary-project-mcp-disable': 'Turn off MCP server “{{name}}” in project “{{project}}”',
  'journal-project-permission-add': 'Adding a project permission',
  'summary-project-permission-add': 'Add permission {{pattern}} to project “{{project}}”',
  'journal-project-permission-edit': 'Editing a project permission',
  'summary-project-permission-edit': 'Edit permission {{pattern}} of project “{{project}}”',
  'journal-project-permission-remove': 'Removing a project permission',
  'summary-project-permission-remove': 'Remove permission {{rule}} from project “{{project}}”',
  'label-project-decision': 'Decision',
  'value-project-decision-allow': 'allow without asking',
  'value-project-decision-ask': 'ask',
  'value-project-decision-deny': 'deny',
  'journal-project-group-choice-set': 'Switching the group in a project',
  'summary-project-group-choice': 'Make group “{{group}}” the active one in project “{{project}}”',
  'summary-project-group-choice-reset':
    'Return every group pair of project “{{project}}” to its project group',
  'journal-project-git-checkout': 'Switching a git branch',
  'summary-project-git-checkout': 'Switch “{{project}}” to branch {{branch}}',
  'journal-project-git-branch': 'New git branch',
  'summary-project-git-branch': 'Create branch {{branch}} in “{{project}}” and switch to it',
  'journal-project-git-commit': 'Git commit',
  'summary-project-git-commit_one':
    'Commit all changes ({{count}} file) to branch {{branch}} of project “{{project}}”',
  'summary-project-git-commit_other':
    'Commit all changes ({{count}} files) to branch {{branch}} of project “{{project}}”',
  'journal-project-git-pull': 'Pulling git commits',
  'summary-project-git-pull': 'Pull commits from the remote repository into “{{project}}”',
  'label-project-git-branch': 'Branch',
  'label-project-git-message': 'Commit message',
  'label-project-git-files': 'Files',
  'label-project-git-source': 'From',
  'value-project-git-push-human':
    'The commit stays on this machine: only you can send it to the server with “Push”',
  'journal-project-worktree-add': 'New working copy',
  'summary-project-worktree-add':
    'Create a working copy for branch {{branch}} of project “{{project}}”',
  'journal-project-worktree-remove': 'Removing a working copy',
  'summary-project-worktree-remove': 'Remove working copy {{path}}',
  'journal-project-worktree-bootstrap': 'Installing dependencies in a copy',
  'summary-project-worktree-bootstrap': 'Start installing dependencies in copy {{path}}',
  'journal-project-worktree-mirror': 'Bringing the local layer into a copy',
  'summary-project-worktree-mirror':
    'Bring the project’s local layer into copy {{path}} (only what is older in the copy)',
  'label-project-worktree-path': 'Copy folder',
  'label-project-worktree-install': 'Command after creation',
  'value-project-worktree-install-none': 'none: no own command and no lockfile',
  'value-project-worktree-force': 'uncommitted changes in the copy will be lost',
  'journal-project-mirror-settings': 'Project copy settings',
  'summary-project-mirror-settings': 'Change the copy settings of project “{{project}}”',
  'journal-project-split-settings': 'Project split settings',
  'summary-project-split-settings': 'Change the split settings of project “{{project}}”',
  'journal-project-runner-settings': 'Dev server settings',
  'summary-project-runner-settings': 'Change the settings of dev server “{{target}}”',
  'journal-project-runner-autostart': 'Dev server autostart',
  'summary-project-runner-autostart-on': 'Turn on autostart of dev server “{{target}}”',
  'summary-project-runner-autostart-off': 'Turn off autostart of dev server “{{target}}”',
  'value-project-runner-autostart':
    'the command runs by itself on every next panel start, with no card',
  'journal-project-runner-start': 'Starting a dev server',
  'summary-project-runner-start': 'Start dev server “{{target}}”',
  'journal-project-runner-stop': 'Stopping a dev server',
  'summary-project-runner-stop': 'Stop dev server “{{target}}”',
  'journal-project-free-port': 'Freeing a port',
  'summary-project-free-port': 'Free port {{port}}: stop the processes listening on it',
  'label-project-runner-port': 'Port',
  'label-project-runner-script': 'package.json script that will run',
  'label-project-port-holders': 'Listening on the port',
} satisfies ProjectTexts;
