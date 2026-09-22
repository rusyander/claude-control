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
  'mcp-server-not-found': 'Server not found',
  'instructions-global-missing': 'The active provider has no global instructions section.',
  'rule-not-found': 'Rule not found',
  'content-must-be-string': 'The content field must be a string (an empty string is allowed).',
  'instructions-file-name-must-be-string': 'The instructions file name must be a string.',
  'instructions-file-name-unknown':
    'The name “{{requested}}” is not one the CLI reads under the current instructionFiles mode.',
  'instructions-file-exists':
    'An instructions file already exists ({{current}}) — the panel neither renames it nor creates a second one.',
  'group-cycle': 'Group nesting forms a cycle',
  'group-not-found': 'Group not found',
  'group-state-unspecified': 'No group state specified',
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
  'portability-subscription-unknown': 'There is no subscription for this target.',
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
    'The hooks failed validation. OpenCode: the command is a non-empty list of non-empty arguments, the file pattern is non-empty and unique, environment variable names are non-empty and unique. Qwen and Kimi: the event comes from the documented list, the command is non-empty and single-line, a matcher only for events that support it, the timeout is an integer within the allowed bounds.',
  'hooks-draft-invalid':
    'The hooks failed validation: the command is a non-empty list of non-empty arguments, the file pattern is non-empty and unique, environment variable names are non-empty and unique.',
  'mcp-draft-invalid':
    'The server draft failed validation: a name, a transport and a command (stdio) or an address (http) are required.',
  'provider-unknown': 'The panel does not know provider “{{id}}”.',
  'config-dir-unsuitable': 'The configuration folder is not suitable.',
  'config-preview-field-missing': 'This action is missing a field (id, draft or isEnabled).',
  'automation-name-missing': 'No scenario name specified',
  'automation-event-missing': 'No scenario event specified',
  'automation-command-missing': 'No scenario command specified',
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
  'script-not-found': 'The script «{{id}}» was not found',
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
};
