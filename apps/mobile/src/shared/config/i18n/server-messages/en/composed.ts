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
  'integration-check-atlassian-confluence-ok':
    'Logged in as {{account}} ({{deployment}}). Confluence is reachable.',
  'integration-check-atlassian-confluence-rejected':
    'Logged in as {{account}} ({{deployment}}). Confluence rejected the token — fill in the separate Confluence key.',
  'integration-check-atlassian-confluence-failed':
    'Logged in as {{account}} ({{deployment}}). Confluence answered {{status}} — check the Confluence address.',
  'integration-check-atlassian-confluence-unreachable':
    'Logged in as {{account}} ({{deployment}}). Confluence is unreachable: {{reason}}.',
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
  'split-triage-interrupted-hold':
    'The triage was cut short by a panel restart and will never give a result. Start the group as proposed? Your answer rides into its task.',
  'split-triage-interrupted-notice':
    'The triage was cut short by a panel restart — there will be no result. Groups waiting for your answer: {{groups}}; they will not start by themselves.',
  'split-groups-interrupted-notice':
    'Group processes were cut short mid-turn: {{groups}}. The panel resumes them itself with a state rebuild (resumed: {{resumed}}); the rest wait for the «Resume» button in the hub.',
  'child-tell-notice':
    'The parent wrote to its groups. Delivered: {{sent}} · queued until their turn ends: {{queued}} · not delivered (the group has no chat or copy): {{refused}}.',
  'split-triage-groups-picked-notice': 'The triage picked panel groups: {{picks}}.',
  'path-step-started-notice': 'Group path step “{{step}}” runs in this chat.',
  'path-gate-failed-notice':
    'Path step “{{step}}” did not pass its check: {{note}}. The chain waits for an answer in this chat.',
  'split-limit-wait-notice':
    'Split groups hit the subscription limit and wait for its reset at {{until}}: they resume by themselves, and the queue does not start until then.',
  'split-limit-warning-notice':
    'The subscription limit is running low: new split groups do not start until its reset at {{until}}, running groups keep working.',
  'split-delivery-description-unchecked-notice':
    'Group «{{group}}»: the panel did not check the description of MR {{mr}} — the MR cannot be read (the forge integration is off or there is no token). Check the description yourself.',
  'split-mr-watch-limit-notice':
    'Group «{{group}}»: the MR watcher for {{mr}} has resumed it {{resumes}} times and stops resuming it by itself — new reviewer threads and pipeline failures wait for you.',
  'split-default-drift-notice':
    'Group «{{group}}»: {{target}} moved ahead and touched its files ({{count}}): {{files}}. The panel leaves the branch alone mid-work — the delivery rebase moves it.',
  'chat-autonomy-deferred-notice':
    "The agent's background commands are still running ({{count}}): the chat process restarts with the new autonomy setting once they finish — restarting now would kill them. Until then the process itself keeps its previous autonomy marker.",
  'chat-stop-unconfirmed-notice':
    "The agent process ({{pid}}) could not be stopped: without a process snapshot the panel cannot verify that this number is still the agent's, and it never touches a foreign process. The run stays running — press Stop again; after a panel restart it is picked up again.",
  'split-group-run-not-started': 'the run did not start',
  'split-group-dropped': 'the group was removed by a human',
  'split-group-chain-failed': 'the chain ended with an error or a stop',
  'split-group-plan-cancelled': 'the plan was cancelled by a human',
  'split-delivery-unverifiable':
    'delivery cannot be checked: the remote did not answer {{checks}} times in a row ({{reason}})',
  'split-delivery-local-failed':
    'delivery cannot be checked: the group copy cannot be read ({{reason}})',
  'split-delivery-incomplete': 'delivery not completed: {{missing}}',
  'split-delivery-incomplete-2': 'delivery not completed: {{first}}; {{second}}',
  'split-delivery-incomplete-3': 'delivery not completed: {{first}}; {{second}}; {{third}}',
  'split-delivery-remote-down':
    'the remote is unreachable since {{since}}: the panel checks it every {{minutes}} min and resumes the group once it answers ({{reason}})',
  'split-delivery-remote-silent': 'the remote did not answer: {{reason}}',
  'delivery-gap-dirty': 'uncommitted changes: {{files}}',
  'delivery-gap-dirty-more': 'uncommitted changes: {{files}} and {{more}} more',
  'delivery-gap-not-pushed':
    'branch {{branch}} is not pushed to the remote (or lags behind the copy HEAD)',
  'delivery-gap-no-mr': 'no MR whose head is the copy HEAD (branch {{branch}})',
  'delivery-gap-review-unfinished': 'the work review is not finished: there is no reviewer verdict',
  'delivery-gap-fix-missing':
    'review findings ({{count}}) are not fixed: the fix stage did not run after the review',
  'delivery-gap-mr-description': 'MR {{mr}} has an empty description',
  'delivery-gap-no-copy': 'the group has no copy',
  'sieve-gap-conflicts':
    'integration sieve: merging with fresh main conflicts in {{files}} — rebase the branch onto fresh main and resolve the conflict',
  'sieve-gap-foreign-removals':
    'foreign-removals sieve: the branch deletes lines that landed in main after the group started: {{files}} — restore them or name every file in the foreign-removals row of the sieve report with the reason',
  'sieve-gap-consumers':
    'consumers sieve: removed names ({{tokens}}) are still used in {{files}} — fix the consumers or name every file in the consumers-repo-wide row of the sieve report with the reason',
  'sieve-gap-unreported':
    'sieve {{sieve}} is not reported: a row is needed in a {{lang}} block — {"sieves":[{"id":"…","status":"pass|fail|n/a","evidence":"the command and a line of its output, or the reason"}]}',
  'sieve-gap-no-evidence':
    'sieve {{sieve}} is marked without evidence: the command and a line of its output, or the reason, are needed',
  'sieve-gap-failed': 'sieve {{sieve}} failed: {{evidence}}',
  'sieve-gap-lockfile':
    'lockfile sieve: a dependency manifest changed without its lockfile: {{files}} — regenerate the lock with the project package manager or name every manifest in the lockfile-sync row of the sieve report with the reason',
  'sieve-gap-secrets':
    'secrets sieve: a key, token or private key in added lines: {{files}} — remove it from the branch and rotate it (a secret removed from the branch has still leaked) or name every file in the secrets row of the sieve report with why it is not a real secret',
  'sieve-gap-debug':
    'debug-leftovers sieve: .only, debugger or a conflict marker in added lines: {{files}} — remove them or name every file in the debug-leftovers row of the sieve report with the reason',
  'sieve-gap-artifacts':
    'committed-artifacts sieve: files that do not belong in git were added (ignored, .env, keys, over 5 MB): {{files}} — remove them from the branch or name each in the committed-artifacts row of the sieve report with the reason',
  'sieve-gap-env':
    'env-config sieve: the code started reading environment variables declared nowhere: {{names}} — add them to .env.example, the deployment config or the docs, or name each in the env-config row of the sieve report with the reason',
  'sieve-gap-untested':
    'tests-alongside sieve: code changed ({{files}}) but no test changed in the branch — add a test for the changed behaviour or report the tests-alongside row: which test covers it, or n/a with the reason',
  'sieve-gap-checks':
    'sieve {{sieve}}: the evidence does not name the project checks {{commands}} — run each on the final commit and name it with its output line; one that could not run is a fail with the reason, not an n/a',
  'sieve-gap-destructive':
    'migration-safety sieve: destructive statements (DROP, TRUNCATE, rename, type narrowing) in {{files}} — the migration-safety row must name every file with its data-preserving and rollback plan',
  'sieve-gap-stale':
    'sieve {{sieve}}: the branch changed the code this sieve covers after the row was reported ({{files}}) — check again on the final commit and report the row again',
  'sieve-gap-no-run':
    'sieve {{sieve}}: the project has a Tests section — record the live check as a run (tests-cli run or tests-cli record) and cite it in the evidence as run:<id>',
  'sieve-gap-run-missing':
    'sieve {{sieve}}: run {{run}} is not in the Tests history of the copy or did not finish — record the run and cite its id',
  'sieve-gap-run-empty':
    'sieve {{sieve}}: run {{run}} checked nothing — every case was skipped or it has no results; bring the stand up and record a new run',
  'sieve-gap-run-red':
    'sieve {{sieve}}: run {{run}} has red cases: {{cases}} — fix them and record a new run',
  'sieve-gap-run-stale':
    'sieve {{sieve}}: run {{run}} is older than the change to the code this sieve covers ({{files}}) — run it again on the final commit',
  'tests-gap-no-run':
    'Tests block of the copy: no run has been recorded since the group started — run the cases for the changed files ({{cases}}) and record the run: {{command}}',
  'tests-gap-stale':
    'Tests block of the copy: run {{run}} was recorded before the latest change ({{files}}) — run the cases again and record the run: {{command}}',
  'tests-gap-unrun':
    'Tests block of the copy: cases for the changed files were not run since the group started: {{cases}} — record a run: {{command}}',
  'tests-gap-failed':
    'Tests block of the copy: red cases in the group’s runs: {{cases}} — fix them and run again',
  'tests-gap-uncovered':
    'Tests block of the copy: the changed files are not covered by any case ({{files}}) — add a case with codePaths pointing at them',
};
