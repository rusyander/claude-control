import type { ComposedMessageCode } from '@agentdeck/contracts/server-messages';

export const composedEn: Record<ComposedMessageCode, string> = {
  'transfer-platform-key': 'the key of contour «{{id}}»',
  'transfer-platform-address-changed':
    'the address differs (it was {{baseUrl}}) — the saved key will be dropped, enter the key of the new address',
  'transfer-platform-key-saved': 'the key of this contour is already saved on this machine',
  'transfer-platform-key-absent':
    'the key does not go into the archive — enter it after the restore',
  'transfer-platform-cert-missing': 'there is no certificate file at {{path}}',
  'transfer-platform-project-paths':
    'the project paths come from the previous machine, check them on this one',
  'transfer-platform-exclusion':
    "{{title}}: both sides are on — saving this contour will be refused, switch one off on the contour's card",
  'plugins-list-failed': 'The plugin list was not obtained: {{reason}}',
  'commands-dir-missing': 'The commands directory was not found: {{path}}.',
  'integration-check-webhook-ok': 'The receiver answered the probe event.',
  'integration-check-webhook-signed':
    'The receiver answered the probe event (the body was signed).',
  'integration-check-logged-in': 'Logged in as {{account}}.',
  'integration-check-telegram-ok': 'The bot {{account}} is reachable.',
  'integration-check-tms-ok': '{{detail}} — the connection works.',
  'integration-check-atlassian-ok': 'Logged in as {{account}} ({{deployment}}).',
  'integration-deployment-cloud': 'cloud',
  'integration-deployment-own': 'own installation',
  'integration-tms-project': '{{system}}, project {{project}}',
  'tms-cases-truncated':
    "the project's case list was cut at {{max}} — a case may have stayed beyond that boundary",
  'tms-check-marks': 'check that the «tms:» marks come from this project and not from another one',
  'env-move-settings-only': 'Only variables from settings.json / settings.local.json can be moved.',
  'mcp-handshake-timeout': 'The server did not answer the handshake in time',
  'mcp-oauth-timeout': 'The server did not answer in time',
  'env-name-invalid':
    'A variable name is Latin letters, digits and underscores, not starting with a digit: MY_TOKEN, not «my token».',
  'env-source-invalid':
    'Where to save: settings, settings-local or secrets. Group variables are edited on the groups page.',
  'env-secret-single-line':
    'A value for .mcp-secrets.env is a single line: a line break would become a separate variable.',
  'env-key-exists-there': '{{file}} already holds {{key}} — delete or rename it there first.',
  'panel-mcp-no-section':
    'The active CLI ({{provider}}) has no MCP section — the bridge has nowhere to register. Switch the active CLI in the settings.',
  'instructions-file-absent':
    'The file {{path}} does not exist. The panel does not create files that are missing: create it yourself or drop the entry from the list.',
  'instructions-path-is-dir': 'The path {{path}} is a directory, not a file.',
  'instructions-file-too-large': 'The file {{path}} is too large to edit in the panel.',
  'instructions-file-not-text':
    'The file {{path}} is not a text file — the panel does not open it.',
  'mcp-auth-header-rejected':
    'The server rejected the Authorization header (401) — check the token in the headers',
  'mcp-oauth-needed': 'OAuth authorization is needed — press «Authorize»',
  'project-dir-empty': 'The path to the project is not set',
  'project-dir-absent': 'The directory does not exist: {{dir}}',
  'project-dir-not-dir': 'This is not a directory: {{dir}}',
  'tests-baseline-png-broken': 'The snapshot did not parse',
  'tests-compare-plans-differ': 'the runs followed different plans',
  'tests-compare-envs-differ': 'the environments differ',
  'tests-compare-modes-differ': 'these are different modes',
  'tests-compare-warning':
    '{{parts}} — the case sets do not match, and «fixed» may mean «not run this time».',
  'tests-compare-base-missing': 'There is no run «{{id}}» in the history.',
  'tests-compare-first-run':
    'There is nothing to compare with: this is the first run with results.',
  'tests-draft-item-unparsed': 'Edit №{{index}} did not parse.',
  'tests-draft-op-refused':
    'Edit №{{index}}: «{{op}}» is not done by a draft — deleting cases stays with the human.',
  'tests-draft-group-missing': 'Edit №{{index}}: the group is not named.',
  'tests-draft-title-missing': 'Edit №{{index}}: a case without a title.',
  'tests-draft-moved-to-group':
    'New cases moved into the group «{{group}}»: {{count}} — the human chose it at the start.',
  'tests-draft-human-case': 'The case was written by a human — an edit to it is accepted by hand.',
  'tests-pdf-no-browser':
    'A browser prints the PDF, and none was found on this machine. Install Google Chrome, Microsoft Edge or Chromium (or name its path in the {{env}} environment variable) — the other report formats work without it.',
  'sandbox-event-custom-title': 'Your own input',
  'chat-run-not-in-ledger':
    'The panel was restarted and the run is not in the ledger — send the message again.',
  'chat-run-stopped-no-answer': 'The run was stopped: there was no answer.',
  'dlp-rule-id-duplicate': 'the rule «{{name}}»: the identifier repeats',
  'dlp-rule-regex-broken': 'the rule «{{name}}»: the expression does not parse',
  'dlp-rule-no-builtin': 'the rule «{{name}}»: no built-in sample is chosen',
  'dlp-rule-dictionary-empty': 'the rule «{{name}}»: the dictionary is empty',
  'media-block-too-large': 'The block is too large — the panel does not accept it.',
  'endpoint-probe-timeout': 'The address did not answer within {{seconds}} s.',
  'group-by-id-absent': 'There is no group «{{id}}».',
  'group-name-taken':
    'The group «{{name}}» already exists — it is found and deleted by name, and there must not be two of them.',
  'automation-not-found': 'There is no automation «{{id}}».',
  'group-env-key-invalid':
    'The variable name «{{key}}» will not do: latin letters, digits and underscore, not starting with a digit.',
  'tests-lint-no-oracle': 'Nothing to prove the result with',
  'tests-lint-step-without-expected': 'A step with no expectation',
  'tests-lint-no-code-paths': 'No link to the code',
  'tests-lint-no-priority': 'No priority',
  'tests-lint-too-many-steps': 'The scenario is too long',
  'tests-lint-undeclared-parameter': 'The parameter is not declared',
  'tests-lint-unused-parameter': 'The parameter is declared for nothing',
  'tests-lint-duplicate-title': 'A repeated title inside the group',
  'tests-lint-obsolete-not-archived': 'An obsolete case is not archived',
  'tests-lint-stale-draft': 'The draft has been sitting too long',
  'tests-lint-not-run': 'Not run for a long time',
  'tests-lint-checklist-with-expected': 'A checklist with an expectation',
  'worktree-copy-gap-files': 'missing files: {{files}}',
  'worktree-copy-gap-links': 'missing links: {{links}}',
  'worktree-copy-gap-access': 'no access entry — the agent will ask about trust and MCP',
  'worktree-mirror-moved': 'Local layer: {{count}} copied',
  'worktree-mirror-linked': 'by link: {{paths}}',
  'worktree-mirror-kept': '{{count}} unchanged',
  'worktree-mirror-skipped-count': '{{count}} skipped',
  'worktree-mirror-unlisted': 'left out: {{paths}}',
  'worktree-mirror-failed': 'The local layer was not copied: {{reason}}',
  'worktree-access-copied': 'Copy access: trust and MCP settings carried over ({{fields}} fields)',
  'worktree-access-skipped': 'Copy access was not created: {{reason}}',
  'worktree-access-reason-unknown': 'git named no reason',
  'worktree-copy-incomplete-line': 'The copy is incomplete: {{gaps}}',
  'worktree-created': 'Copy {{target}} is ready on branch {{branch}}',
  'worktree-longpath-refused':
    'Windows refused to create the copy at {{target}}: the path is longer than 260 characters.\nThe panel already asks git for long paths and shortens the directory name, but the depth of the\nrepository itself is not its choice. Turn long paths on in the system — Local Group Policy Editor\n→ Computer Configuration → Administrative Templates → System → Filesystem → “Enable Win32 long\npaths”, or in the registry\nHKLM\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\FileSystem\\\\LongPathsEnabled = 1 — and repeat.\nQuick workaround: move the repository closer to the drive root.\n\ngit answered: {{error}}',
  'git-failed-no-output': 'The git command failed',
  'worktree-install-started': 'Installation started: {{command}}',
};
