import type { ConfigMessageCode } from '@agentdeck/contracts/server-messages';

export const configEn: Record<ConfigMessageCode, string> = {
  'config-dir-path-required': 'Specify the path to the configuration folder.',
  'settings-invalid': 'The settings failed validation and were not saved.',
  'state-import-invalid': 'The imported state failed validation and was not applied.',
  'credentials-paste-empty': 'Empty: paste JSON or an API key.',
  'config-format-unrecognized-readonly':
    'The configuration file format is not recognized — writing is disabled (the section is read-only).',
  'hook-event-unspecified': 'No hook event specified',
  'hook-direction-unspecified': 'No direction specified',
  'hook-description-outside-relay':
    'Panel hook for terminal and VS Code sessions — control from the phone. PermissionRequest — an agent question or a permission request also goes to the phone; the window on the computer shows it at the same time, the first decision wins. PostToolUse, Stop — a message written from the phone mid-turn reaches the agent after the next step or instead of stopping. Any failure exits without a decision: the CLI behaves as with no hook. The hook must neither crash nor hang the session. Arguments: --url <panel address> --token-file <token file>',
  'hook-description-tests':
    'Hook of the «Tests» block for any Claude Code over the project — panel chat, VS Code, terminal. The panel puts it into the project’s .claude/settings.local.json — that file does not go to git. node tools/tests-hook.mjs session   SessionStart: a short line about the block node tools/tests-hook.mjs stop      Stop: code was edited — case, run, record Economy is the main requirement: a turn without edits exits without reading the domain (one node start, zero tokens); a gap is raised at most once per turn (`stop_hook_active`), and each gap carries a ready command, so the extra turn is just one.',
  'mcp-server-not-found': 'Server not found',
  'instructions-global-missing': 'The active provider has no global instructions section.',
  'rule-not-found': 'Rule not found',
  'rule-title-taken': 'A rule named “{{title}}” already exists — choose another title',
  'content-must-be-string': 'The content field must be a string (an empty string is allowed).',
  'instructions-file-name-must-be-string': 'The instructions file name must be a string.',
  'instructions-file-name-unknown':
    'The name “{{requested}}” is not one the CLI reads under the current instructionFiles mode.',
  'instructions-file-exists':
    'An instructions file already exists ({{current}}) — the panel neither renames it nor creates a second one.',
  'group-cycle': 'Group nesting forms a cycle',
  'sieve-not-found': 'This learned sieve is already gone',
  'group-not-found': 'Group not found',
  'group-state-unspecified': 'No group state specified',
  'group-request-invalid': 'Malformed request: {{detail}}',
  'group-path-steps-invalid': 'Path steps not saved: {{detail}}',
  'group-path-step-not-found': 'Path step not found',
  'group-pair-both-active':
    'Both groups of the pair would be active in the project — choose one first',
  'group-not-paired': 'This group is not a side of a pair in this project',
  'group-not-project': 'This is not a project group',
  'group-not-global': 'This is not a global group',
  'group-already-copied':
    'This group already has a global copy — update it by merging with the original',
  'group-origin-missing': 'The group has no project original',
  'group-advice-empty': 'No advice is waiting to be applied',
  'group-advice-masked':
    'The model replacement carries hidden values that could not be put back — the advice was not applied',
  'group-model-failed': 'The model did not answer: {{reason}}',
  'group-model-unreadable': 'The model answer could not be read',
  'group-override-foreign-file':
    'The project already has its own {{file}} — the panel does not overwrite it',
  'group-override-claude-only': 'Project override exists for Claude only',
  'group-project-missing': 'Project directory not found',
  'group-promote-invalid': 'Resource not created: {{detail}}',
  'group-copy-target-unknown': 'Provider “{{provider}}” is unknown to the panel',
  'config-format-unrecognized':
    'The configuration file format is not recognized — writing is disabled.',
  'plugin-unspecified': 'No plugin specified',
  'plugin-state-unspecified': 'No plugin state specified',
  'plugin-source-unspecified': 'No source specified',
  'plugin-dir-or-name-unspecified': 'No plugin folder or name specified',
  'project-files-claude-only':
    'Claude project files are available only while Claude is the active provider.',
  'prompt-gate-enabled-expected': 'The enabled field is expected.',
  'prompt-gate-action': 'Action: block or warn.',
  'prompt-not-in-catalog': 'There is no such prompt in the catalog.',
  'prompt-text-required': 'The prompt text is required.',
  'provider-unknown-to-panel': 'The panel does not know this provider.',
  'compare-target-format-unrecognized':
    'The target file format is not recognized — the panel does not write to it.',
  'portability-importer-missing': 'The panel cannot read this CLI environment yet.',
  'portability-scope-unknown': 'The passport level is either «global» or «project».',
  'portability-project-required': 'The project level needs a named project.',
  'portability-project-unknown': 'The panel does not know this project.',
  'portability-project-unsupported':
    'This CLI documents no project-level settings — there is nowhere to carry them.',
  'portability-target-unknown': 'The panel does not know this transfer target.',
  'portability-source-not-readable':
    'This CLI files could not be read: check that its settings are not broken.',
  'portability-emitter-missing': 'The panel cannot write this CLI environment yet.',
  'portability-attachment-unsafe-path':
    'The transfer did not start: attachment «{{path}}» of skill «{{name}}» points outside its folder.',
  'portability-plan-not-shown':
    'Preview first: the panel does not write what it has not shown you. Open the transfer plan again.',
  'portability-plan-stale':
    'The files have changed since the preview — the plan was recalculated. Review it again and apply.',
  'portability-backups-off':
    'The transfer did not start: backups are off, and without them there would be nothing to undo it with.',
  'portability-target-not-writable':
    'The transfer did not start: a target file is not writable — it is busy, read-only, or the disk is full.',
  'portability-apply-rolled-back':
    'The write failed — the transfer was undone entirely, the files are back as they were.',
  'portability-apply-rollback-failed':
    'The write failed, and so did the rollback: some files stayed changed. The copies are in the backups folder.',
  'portability-transfer-not-found':
    'There is nothing to undo: the panel has not transferred anything to this target.',
  'portability-subscription-layer-unknown': 'The canon has no such layer.',
  'portability-subscription-held':
    'The rebuild is on hold: either the projection was built by another canon version, or no layer is subscribed.',
  'portability-drift-resolution-unknown':
    'A divergence has three outcomes: take it into the canon, restore the projection, or unsubscribe the layers of that file.',
  'portability-drift-absent':
    'This target file matches what the panel left there: there is nothing to settle.',
  'portability-drift-file-missing':
    'The target has no such file: there is nothing to take into the canon — restore the projection or unsubscribe the layers.',
  'portability-drift-nothing-to-adopt':
    'This file holds no records of the subscribed layers: there is nothing to take into the canon.',
  'portability-drift-nothing-to-do':
    'This outcome produces no edit at all: look at the plan again.',
  'portability-carry-nothing-chosen': 'No conversation is selected: there is nothing to carry.',
  'portability-needs-instructions':
    'the model reads the instructions text; it needs no runtime facts',
  'portability-needs-skill':
    'the model picks the skill by its description; it needs no runtime facts',
  'portability-needs-command': 'the command expands into ready text and takes no arguments',
  'portability-needs-subagent': 'the subagent gets its task as text; it needs no runtime facts',
  'portability-needs-secret': 'the key serves the whole process; it needs no conversation facts',
  'portability-needs-env':
    'the environment variable always applies and needs no conversation facts',
  'portability-needs-mcp': 'the MCP server starts with the CLI and needs no conversation facts',
  'portability-needs-permission-mode':
    'the approval mode applies to the whole CLI and does not inspect call arguments',
  'portability-needs-probe-server':
    "the server answers the model's request and needs no conversation facts",
  'portability-needs-hook-none': 'neither the event nor the script text names any runtime fact',
  'portability-needs-event-unknown':
    'event «{{event}}» is described by no known format: its payload is unknown',
  'portability-needs-plugin':
    "the plugin's contents are analysed separately: its requirements are not known yet",
  'portability-needs-unparsed-entry':
    'not even its own source parses this entry: what it reads is unknown',
  'portability-needs-script-computed-key': 'the script reads the payload by a computed key',
  'portability-needs-script-calls-script':
    "the script calls another script — that script's payload is not visible from here",
  'portability-needs-script-reads-transcript':
    'the script reads the transcript, so it can read anything from the conversation',
  'portability-needs-script-evals': 'the script executes computed code',
  'portability-needs-script-unread': 'script {{path}} was not read: {{detail}}',
  'portability-intent-instructions':
    'instructions file {{name}}: the model reads its text in every conversation',
  'portability-intent-skill': 'skill {{name}}: {{description}}{{subtree}}',
  'portability-intent-skill-account-only':
    'skill {{name}}: the source is the account, there is no file on disk{{subtree}}',
  'portability-intent-skill-account-synced':
    'skill {{name}}: synced with the account, the account owns the entry{{subtree}}',
  'portability-intent-subtree-attached': ' (attachments: {{count}})',
  'portability-intent-subtree-skipped': ' (not transferred: {{count}})',
  'portability-intent-subtree-both': ' (attachments: {{attached}}, not transferred: {{skipped}})',
  'portability-intent-no-description': 'no description',
  'portability-intent-command': 'command {{command}}: {{description}}',
  'portability-intent-subagent': 'subagent {{name}}: {{description}}',
  'portability-intent-plugin': 'plugin {{name}}',
  'portability-intent-secret':
    'key {{key}}: the value stays with its holder and is not transferred',
  'portability-intent-env': 'environment variable {{key}}',
  'portability-intent-hook': 'on {{event}} runs: {{command}}',
  'portability-intent-hook-matcher': 'on {{event}} with filter {{matcher}} runs: {{command}}',
  'portability-intent-hook-preserved': 'entry {{key}}, whose shape its source does not parse',
  'portability-intent-mcp-sdk':
    '{{name}}: the server lives inside the SDK process: the host application registers it at start, not a configuration file{{off}}',
  'portability-intent-mcp-stdio': 'tool server {{name}}: started by the command {{command}}{{off}}',
  'portability-intent-mcp-url': 'tool server {{name}}: {{url}}{{off}}',
  'portability-intent-mcp-off': ' — off',
  'portability-intent-mode-policy': '{{cli}} approval policy: {{mode}}{{defaults}}',
  'portability-intent-mode-approval': '{{cli}} approval mode: {{mode}}{{defaults}}',
  'portability-intent-mode-plain': '{{cli}} mode: {{mode}}{{defaults}}',
  'portability-intent-mode-default': ' (CLI default, the key is not in the file)',
  'portability-intent-tool-allowed': 'tool allowed: {{rule}}',
  'portability-intent-tool-denied': 'tool denied: {{rule}}',
  'portability-intent-rule-allowed': 'allowed: {{rule}}',
  'portability-intent-rule-ask': 'ask: {{rule}}',
  'portability-intent-rule-denied': 'denied: {{rule}}',
  'portability-intent-rule-unavailable': 'unavailable: {{rule}}',
  'portability-intent-claude-rule-off':
    '{{decision}}: {{rule}} — turned off by the panel, not in the settings file',
  'portability-intent-probe-hook': 'Probe: the hook must stop the agreed forbidden call.',
  'portability-intent-probe-skill': 'Probe: the skill must reach the model with the agreed word.',
  'portability-intent-probe-command': 'Probe: the command must expand into the agreed text.',
  'portability-intent-probe-permission':
    'Probe: the permission must refuse reading the agreed file.',
  'portability-intent-probe-mcp': 'Probe: the MCP tool must appear in the model’s list.',
  'portability-intent-probe-env': 'Probe: the environment variable must reach the tool process.',
  'portability-skip-no-section-project': '{{provider}} has no such section at the project level',
  'portability-skip-no-section': '{{provider}} has no such section',
  'portability-skip-project-undocumented':
    '{{provider}} documents no project-level settings — there is nowhere to carry them',
  'portability-skip-file-missing': 'file {{path}} does not exist',
  'portability-skip-file-absent': '{{path}}: the file is not on disk',
  'portability-skip-rule-extension': '{{path}}: this CLI does not read files with this extension',
  'portability-skip-section-unreadable': '{{where}}: section not read — {{cause}}',
  'portability-cause-not-json': 'the file is not valid JSON',
  'portability-cause-unparsed': 'the file content cannot be parsed',
  'portability-skip-mcp-block': '{{path}}: {{reason}}',
  'mcp-block-unparsed':
    'The block file does not fit the panel’s model (for example, an entry without a name or a `uses:` reference) — the panel neither shows nor edits it.',
  'mcp-block-duplicate':
    'The MCP server name from this file is already taken by another file — the panel cannot address the entry unambiguously and leaves the file alone.',
  'portability-section-hooks-off':
    '{{path}}: the disableAllHooks key switches off the whole section',
  'portability-skip-no-skill-file': '{{name}}: the folder has no SKILL.md',
  'portability-skip-command-body-config': '{{command}}: the command body is not in a file',
  'portability-skip-no-records': '{{where}}: no entries',
  'portability-skip-import-problem': '{{file}}: {{problem}}',
  'portability-import-cycle': 'import cycle: {{path}} is already included above',
  'portability-import-depth': 'import depth exceeded ({{depth}}): {{path}}',
  'portability-import-unread': 'import not read: {{path}}',
  'portability-skip-mcp-transport':
    '{{name}}: transport “{{transport}}” is not described by any CLI',
  'portability-skip-mcp-sdk':
    '{{name}}: the server lives inside the SDK process: the host application registers it at start, not a config file',
  'portability-skip-hook-event':
    'event “{{event}}” is not described by any known format: its payload and meaning must not be invented',
  'portability-skip-hook-script-missing': '{{id}}: script {{path}} is not on disk',
  'portability-skip-codex-sandbox':
    'sandbox_mode = {{mode}}: the CLIs have different sandbox models, there is no mapping (the source CLI refuses too)',
  'portability-skip-permission-preserved':
    'the panel does not manage permission.{{key}}: the key’s shape is not documented',
  'portability-skip-codex-approval':
    'approval_policy = {{value}}: the panel does not parse this value and it does not go into the passport — showing the default instead would describe an environment that does not exist',
  'portability-skip-codex-agents':
    'the [agents] key in config.toml: the panel does not parse Codex subagents yet, although the CLI’s own one-way importer carries them',
  'portability-skip-codex-skills':
    'the [[skills.config]] key in config.toml: the panel does not parse turning Codex skills on and off yet, although the CLI’s own one-way importer carries it',
  'portability-skip-codex-prompts':
    'the ~/.codex/prompts folder: the panel does not parse Codex commands yet, although the CLI’s own one-way importer carries them',
  'portability-skip-plugin-registry-missing': '{{path}}: there is no plugin registry',
  'portability-skip-plugin-registry-version':
    '{{path}}: registry version {{version}}, Claude Code reads only version {{expected}} — these plugins are not in effect',
  'plugin-registry-no-version': 'without a number',
  'portability-skip-plugin-no-install': '{{id}}: the registry has no install path',
  'portability-skip-plugin-dir-missing': '{{id}}: folder {{path}} is not on disk',
  'portability-skip-plugin-disabled':
    '{{id}}: the plugin is off, its entries are not in effect and are not carried',
  'portability-skip-plugins-home-only':
    'the CLI installs plugins at home level: they have no project level',
  'portability-skip-secrets-home-only':
    'the panel’s secrets file (.mcp-secrets.env) exists only at home level: a project has none of its own',
  'portability-skip-subagent-problem': '{{path}}: {{problem}}',
  'portability-subagent-not-file': 'this is not a regular file',
  'portability-subagent-too-big': 'the file is too large to parse',
  'portability-subagent-no-frontmatter': 'no header block — this is not a subagent',
  'portability-subagent-empty-name': 'the subagent name is empty',
  'portability-skip-project-missing': 'project folder {{path}} is not on disk',
  'portability-skip-project-instructions-key':
    'the projectInstructions key is outdated: the CLI reads it with a warning, the current key is instructionFiles (mode {{mode}}, default {{default}})',
  'instruction-files-settings-unread':
    'the settings file was not parsed; the default mode {{mode}} is used',
  'instruction-files-value-unknown':
    'value “{{value}}” of key {{key}} is not recognised; the default mode {{mode}} is used',
  'instruction-files-managed-only':
    'managed-only mode: the CLI reads none of its own instruction files, only the ones managed by the organisation remain',
  'instruction-files-claude-md':
    'claude-md mode: {{files}} is right here, but the CLI does not read it',
  'instruction-files-claude-or-agents':
    'claude-md-or-agents-md mode: CLAUDE.md is right here, so the CLI does not read {{files}}',
  'commands-plugin-registry-version':
    'Plugin registry installed_plugins.json is version {{version}}: Claude Code reads only version {{expected}}, the commands of these plugins do not reach the palette.',
  'commands-plugin-dir-missing': 'Plugin “{{id}}”: install folder not found ({{path}}).',
  'resource-file-unspecified': 'No file specified',
  'resource-template-not-found': 'Template not found',
  'resource-kind-unknown': 'Unknown resource kind',
  'script-content-missing': 'The script content was not passed',
  'script-name-unspecified': 'No script name specified',
  'permissions-draft-invalid':
    'The permission values failed validation: they must come from the allowed sets.',
  'env-draft-invalid': 'The variable set failed validation: each needs a non-empty key and value.',
  'kimi-plugins-readonly':
    'The panel only shows Kimi Code plugins: install, enable and disable them with the /plugins command inside the CLI — the installed registry format is not documented.',
  'qwen-extensions-files-readonly':
    'Qwen Code extensions change only through qwen extensions commands — the panel does not write files in the extensions folder.',
  'installed-actions-unsupported':
    'For the active provider the panel does not change installed extensions.',
  'installed-action-invalid': 'An extension action is enable or disable only.',
  'qwen-extension-source-invalid':
    'The extension source failed the check: one line up to 1000 characters, not starting with “-”.',
  'qwen-extension-not-found': 'Extension “{{name}}” is not installed.',
  'qwen-cli-unavailable': 'Qwen Code CLI did not start — check that qwen is on the server PATH.',
  'qwen-extension-cli-failed': 'Qwen Code refused: {{reason}}',
  'codex-plugins-files-readonly':
    'Codex plugins change only through codex plugin commands — the panel does not write the plugin cache.',
  'plugin-marketplaces-unsupported': 'The active provider has no plugin marketplaces.',
  'codex-plugin-toggle-unrecognized':
    'No [plugins."name@marketplace"] table found in the Codex config.toml — the switch was not written, the file is untouched.',
  'codex-plugin-selector-invalid':
    'A Codex plugin is named name@marketplace: one line without spaces, not starting with “-”.',
  'codex-marketplace-source-invalid':
    'The marketplace source failed validation: one line up to 1000 characters, not starting with “-”.',
  'codex-plugin-not-found': 'Plugin “{{name}}” is not installed.',
  'codex-marketplace-not-found': 'Marketplace “{{name}}” is not added.',
  'codex-cli-unavailable': 'Codex CLI did not start — check that codex is on the server PATH.',
  'codex-plugin-cli-failed': 'Codex refused: {{reason}}',
  'rule-draft-invalid':
    'The rule failed validation: a path inside the rules folder and a text body are required; description and globs are single-line, alwaysApply is a boolean.',
  'gemini-yolo-cli-only':
    'The “yolo” mode cannot be written to settings.json: Gemini allows it only as a command-line flag, and in the settings file it breaks CLI startup. Run it with the `--yolo` flag.',
  'skill-draft-invalid':
    'The skill failed validation: a path like “<name>/SKILL.md”, a single-line name and description, and a text body are required.',
  'plugin-npm-list-invalid':
    'The npm plugin list failed validation: each name is a non-empty string without spaces or quotes, duplicates are not allowed.',
  'instructions-list-invalid':
    'The file list failed validation: each entry must be a non-empty string without line breaks.',
  'instructions-not-rules-dir':
    "The active provider's instructions are not organized as a rules folder.",
  'instructions-not-link-list':
    "The active provider's instructions are not organized as a list of links.",
  'project-instructions-not-link-list':
    "The active provider's project instructions are not organized as a list of links.",
  'project-level-unsupported': 'The active provider has no project-level configuration.',
  'project-mcp-unsupported': 'The active provider has no project MCP server file.',
  'project-instructions-unsupported': 'The active provider has no project instructions file.',
  'project-env-unsupported': 'The active provider has no project environment variables file.',
  'project-permissions-unsupported':
    'The active provider has no project permissions/approvals file.',
  'project-plugins-unsupported': 'The active provider has no project plugins.',
  'project-skills-unsupported': 'The active provider has no project skills.',
  'project-hooks-unsupported': 'The active provider has no project hooks.',
  'mcp-section-unsupported': 'The active provider has no universal MCP section.',
  'env-section-unsupported': 'The active provider has no universal environment variables section.',
  'plugins-section-unsupported': 'The active provider has no universal plugins section.',
  'permissions-section-unsupported':
    'The active provider has no universal permissions/approvals section.',
  'skills-section-unsupported': 'The active provider has no universal skills section.',
  'hooks-section-unsupported': 'The active provider has no universal hooks section.',
  'project-rules-not-mdc':
    "The active provider's project rules are not organized as an .mdc folder.",
  'plugin-file-draft-invalid':
    'The plugin file failed validation: a path inside the plugins folder (.js, .ts or .mjs) and text content are required.',
  'config-format-unrecognized-list-readonly':
    'The configuration file format is not recognized — writing is disabled (the list is read-only).',
  'hooks-draft-invalid-foreign':
    'The hooks failed validation. OpenCode: the command is a non-empty list of non-empty arguments, the file pattern is non-empty and unique, environment variable names are non-empty and unique. Qwen, Kimi and Codex: the event comes from the documented list, the command is non-empty and single-line, a matcher only for events that support it, the timeout is an integer within the allowed bounds.',
  'hooks-draft-invalid':
    'The hooks failed validation: the command is a non-empty list of non-empty arguments, the file pattern is non-empty and unique, environment variable names are non-empty and unique.',
  'mcp-draft-invalid':
    'The server draft failed validation: a name, a transport and a command (stdio) or an address (http) are required.',
  'provider-unknown': 'The panel does not know provider “{{id}}”.',
  'config-dir-unsuitable': 'The configuration folder is not suitable.',
  'config-preview-field-missing': 'This action is missing a field (id, draft or isEnabled).',
  'scenario-trigger-not-regex': 'The trigger expression is not a regular expression',
  'env-body-empty': 'The request body is empty: key, value and source are required.',
  'env-value-string': 'The variable value is a string.',
  'env-comment-string': 'The comment is a string.',
  'env-var-not-found': 'Variable {{key}} is not in {{file}}.',
  'group-field-string': 'Field {{field}} ({{what}}) is a string.',
  'group-members-list': 'The members field is a list of members.',
  'group-env-object': 'The env field is an object “variable name → value”.',
  'group-env-value-string': 'The value of variable {{key}} is a string.',
  'group-scenario-object': 'The scenario field is a scenario object.',
  'group-scenario-steps-list': 'Scenario steps are a list.',
  'group-scenario-step-object': 'A scenario step is an object {title, body, gate}.',
  'group-body-object': 'The request body must be an object describing the set.',
  'group-name-missing': 'The set name is not specified',
  'group-paths-list': 'The projectPaths field is a list of directory paths (strings).',
  'group-enabled-boolean': 'The isEnabled field is true or false.',
  'mcp-field-string-list': 'Field {{field}} must be a list of strings.',
  'mcp-field-string-map': 'Field {{field}} must be an object “name → string”.',
  'mcp-body-object': 'The request body must be an object describing the server.',
  'mcp-name-missing': 'The MCP server name is not specified',
  'mcp-transport-invalid': 'The transport must be one of: {{list}}.',
  'mcp-stdio-command': 'stdio needs a launch command.',
  'mcp-url-required': '{{transport}} needs a server address.',
  'mcp-url-invalid': 'Address “{{url}}” does not parse as an http(s) URL.',
  'permission-pattern-empty': 'Empty permission pattern',
  'permission-pattern-unbalanced':
    'The pattern “{{pattern}}” has an unmatched parenthesis. A qualifier is written like Bash(git status:*).',
  'permission-decision-unknown': 'Unknown decision: {{decision}}',
  'compare-self': 'There is nothing to compare a provider with itself.',
  'migrate-same': 'Source and target are the same.',
  'migrate-from-to': 'Fields from and to must be non-empty strings.',
  'migrate-mode': 'Field mode must be preview or apply.',
  'migrate-keys': 'Field keys must be a list of non-empty strings.',
  'migrate-source-no-mcp': 'The source has no MCP servers section.',
  'migrate-target-no-mcp': 'The target has no MCP servers section.',
  'migrate-source-no-instructions': 'The source has no global instructions file.',
  'migrate-target-no-instructions': 'The target has no global instructions file.',
  'migrate-instructions-missing':
    'The source instructions file does not exist — nothing to transfer.',
  'provider-unknown-quoted': 'Unknown provider “{{providerId}}”.',
  'provider-key-invalid': 'The key is empty or exceeds the allowed length.',
  'plugin-file-not-text': 'File {{fullPath}} is not a text file.',
  'preview-no-mcp': 'The active provider has no MCP section.',
  'preview-server-unspecified': 'No server specified for removal.',
  'preview-server-draft-invalid': 'The server draft did not pass validation.',
  'preview-no-permissions': 'The active provider has no permissions section.',
  'preview-permissions-draft-invalid': 'The permissions draft did not pass validation.',
  'preview-no-env': 'The active provider has no environment variables section.',
  'preview-env-draft-invalid': 'The variables draft did not pass validation.',
  'preview-no-instructions-list': 'The active provider has no instruction files list.',
  'preview-list-draft-invalid': 'The list draft did not pass validation.',
  'skill-name-invalid': 'Invalid skill name.',
  'skill-not-found': 'Skill not found.',
  'skill-name-taken': 'A skill with this name already exists.',
  'mdc-yaml': 'The rule frontmatter does not parse as YAML.',
  'mdc-not-map': 'The rule frontmatter is not a key mapping.',
  'mdc-roundtrip-intent': 'The control parse of the rule did not match the intent.',
  'mdc-roundtrip-body': 'The control parse changed the rule body.',
  'mdc-roundtrip-keys': 'The control parse lost frontmatter keys.',
  'skill-head-yaml': 'The skill header does not parse as YAML.',
  'skill-head-not-map': 'The skill header is not a key mapping.',
  'skill-head-field-missing': 'The skill header has no required field “{{key}}”.',
  'skill-head-field-string': 'Field “{{key}}” in the skill header is not a string.',
  'skill-head-field-empty': 'Required field “{{key}}” in the skill header is empty.',
  'skill-roundtrip-intent': 'The control parse of the skill did not match the intent.',
  'skill-roundtrip-body': 'The control parse changed the skill body.',
  'skill-roundtrip-keys': 'The control parse lost skill header keys.',
  'hook-not-found': 'Hook not found',
  'hook-script-separate': 'The hook script is created by a separate action.',
  'script-not-found-quoted': 'Script “{{id}}” not found',
  'skill-not-found-quoted': 'Skill “{{id}}” not found',
  'migrate-env-refused': 'The panel does not migrate environment variables: they hold keys.',
  'migrate-permissions-refused':
    'Permissions are not migrated: CLIs have different approval models.',
  'migrate-section': 'The section field must be one of: mcp, env, permissions, instructions.',
  'migrate-source-server-missing': 'The source has no such server.',
  'compare-format-unreadable': 'The file format is not recognized — the panel will not read it.',
  'compare-file-absent':
    'No file — the CLI is not installed or has not configured anything yet. Migrating here will create the file.',
  'compare-mcp-unsupported': 'The panel does not manage MCP servers for this CLI.',
  'compare-env-unsupported': 'The panel does not manage environment variables for this CLI.',
  'compare-permissions-unsupported': 'The panel does not manage permissions for this CLI.',
  'compare-instructions-unsupported':
    'Global instructions of this CLI are organized differently — not as a single file.',
  'compare-sse-blocked':
    'The sse transport: other CLIs do not have it, so there is nowhere to migrate it.',
  'compare-disabled-blocked': 'The server is disabled — only enabled ones are migrated.',
  'compare-env-note':
    'Variables are not migrated: their values are usually keys and tokens, and the panel does not write secrets into other configurations.',
  'compare-permissions-note':
    'Each CLI has its own approval model. Matching key names do not mean matching meaning, so permissions are shown side by side but not migrated.',
  'instructions-entry-unlisted':
    'The entry «{{raw}}» is not in the read list of the configuration {{configPath}}.',
  'instructions-entry-outside':
    'The path «{{raw}}» leads outside the project directory — the panel does not open it.',
  'instructions-entry-missing':
    'The file {{path}} does not exist. The panel does not create missing files: create it yourself or remove the entry from the list.',
  'instructions-entry-directory': 'The path {{path}} is a directory, not a file.',
  'instructions-entry-too-large': 'The file {{path}} is too large to edit in the panel.',
  'instructions-entry-binary': 'The file {{path}} is not a text file — the panel does not open it.',
  'skill-not-found-in-dir': 'Skill «{{path}}» was not found in the skills directory.',
  'skill-name-empty': 'The skill name «{{name}}» is not valid: a name is required.',
  'skill-name-too-long':
    'The skill name «{{name}}» is not valid: the name is longer than {{max}} characters.',
  'skill-name-leading-hyphen':
    'The skill name «{{name}}» is not valid: the name cannot start with a hyphen.',
  'skill-name-trailing-hyphen':
    'The skill name «{{name}}» is not valid: the name cannot end with a hyphen.',
  'skill-name-double-hyphen':
    'The skill name «{{name}}» is not valid: two hyphens in a row are not allowed.',
  'skill-name-pattern':
    'The skill name «{{name}}» is not valid: only lowercase Latin letters, digits and single hyphens are allowed.',
  'skill-name-dir-mismatch': 'The skill name «{{name}}» must match its folder name «{{dirName}}».',
  'skill-description-empty':
    'A skill description is required: the CLI uses it to decide when to load the skill.',
  'skill-description-too-long': 'The skill description is longer than {{max}} characters.',
  'script-exists': 'Script «{{id}}» already exists. Choose another name or open it for editing.',
  'skill-id-invalid': 'Invalid skill identifier: «{{id}}»',
  'skill-exists': 'Skill «{{skillId}}» already exists',
  'skill-exists-disabled': 'Skill «{{skillId}}» already exists and is currently disabled',
  'credentials-file-unreadable': 'The file {{path}} cannot be read — check the access permissions.',
  'credentials-file-not-json':
    'The file {{path}} is not JSON. Fix or delete it: the panel will then return to the usual lookup.',
  'credentials-read-from-missing': 'The specified file was not found: {{path}}',
  'credentials-read-from-unreadable': 'The file {{path}} cannot be read.',
  'credentials-file-no-field':
    'The file {{path}} has no known field: claudeAiOauth, apiKey or readFrom is expected.',
  'credentials-not-found-mac':
    'No access was found in the macOS keychain or in a file. Sign in with the `claude` command in a terminal or set access manually in the panel settings.',
  'credentials-not-found':
    'The file {{path}} was not found. Sign in with the `claude` command in a terminal or set access manually in the panel settings.',
  'credentials-paste-not-json': 'This is not JSON. Check the quotes and commas.',
  'credentials-paste-file-missing': 'File not found: {{path}}',
  'credentials-paste-directory': 'This is a directory, not a file: {{path}}',
  'credentials-paste-unreadable': 'The file cannot be read: {{path}}',
  'credentials-paste-no-token': 'claudeAiOauth has no accessToken string field.',
  'credentials-paste-no-field':
    'One of the fields is required: claudeAiOauth (with accessToken), apiKey or readFrom.',
  'mcp-server-exists': 'The MCP server «{{name}}» is already in the configuration.',
  'mcp-field-map-invalid':
    'The field {{field}}: the name «{{key}}» without spaces or service characters, the value as a string.',
  'mcp-name-invalid':
    'The name «{{name}}» will not do: no spaces, slashes or double underscores — permissions of the form mcp__server__tool are built from it.',
  'mcp-vars-missing':
    'The variables {{names}} are not set: add them in the «Variables» section (settings.json → env or .mcp-secrets.env) or into the environment the panel was started from',
  'mcp-oauth-no-verifier': 'The authorization was not started: there is no code_verifier',
  'endpoint-base-url-invalid': 'The endpoint address must be a valid http(s) address.',
  'endpoint-google-https-only':
    'The Gemini CLI accepts only https addresses in its own variable — the only exception is localhost.',
  'endpoint-provider-no-var':
    '«{{provider}}» has no documented environment variable for this kind of API — the profile is not transferred here.',
  'endpoint-provider-no-env':
    '«{{provider}}» has no environment variables section — there is nowhere to write.',
  'hook-file-exists':
    'The file hooks/{{name}} already exists. Give another file name or leave the field empty and set a command.',
  'permission-rule-exists': 'The rule «{{pattern}}» with this decision already exists',
  'permission-not-found': 'The permission «{{id}}» was not found',
  'provider-declared-only':
    'The provider «{{id}}» is only declared at this phase: the file adapter is not implemented, reading and writing are refused.',
  'provider-no-model-api':
    'The provider «{{provider}}» has no model API of its own — a key cannot be set.',
  'provider-env-value-unsupported':
    'The variable «{{key}}» is set in config.toml to a value the panel does not model (a number, a boolean or a table) — rename it here or change the value in the file by hand. The other variables were not saved.',
  'file-too-large-to-edit': 'The file {{path}} is too large to edit in the panel.',
  'file-too-large-to-view': 'The file is too large to view',
  'skill-no-frontmatter':
    'The file has no frontmatter block between the «---» lines — OpenCode does not attach such a skill.',
  'mcp-tools-server-disabled': 'The server is switched off — switch it on to see the tools',
  'mcp-server-not-in-config': 'There is no MCP server «{{name}}» in the configuration.',
  'endpoint-probe-not-json':
    'The answer is not JSON — what answers at this address is not a model API.',
  'endpoint-probe-status': 'The address answered {{status}}{{detail}}',
  'instructions-section-unsupported': 'The active CLI does not support global instructions.',
  'kimi-mode-stale':
    'Kimi Code does not accept {{key}} = "{{mode}}" (allowed: {{allowed}}) and silently drops it at launch, running in manual. The section is read-only: fix the value in the file (kimi doctor config shows the error), and editing opens again.',
};
