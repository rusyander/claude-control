import type { ChecksMessageCode } from '@agentdeck/contracts/server-messages';

export const checksEn: Record<ChecksMessageCode, string> = {
  'checks-section-mcp': 'MCP servers',
  'checks-section-permissions': 'Permissions',
  'checks-section-env': 'Environment variables',
  'checks-skip-own-routes':
    "{{title}}: this section is served by the panel's own routes, the universal write cycle does not apply to it.",
  'checks-skip-absent': '{{title}}: this provider has no such section.',
  'checks-assistant-off': 'Starting the assistant is switched off in this check.',
  'checks-assistant-unsupported': 'The assistant is not supported for this provider.',
  'checks-assistant-launch-failed': 'The launch did not happen: {{reason}}',
  'checks-assistant-nothing-to-run':
    "Nothing to run with: the CLI was not found and no key is set — this is not the provider's refusal.",
  'checks-assistant-error': 'The assistant answered with an error.',
  'checks-assistant-empty': 'The assistant answered with an empty message.',
  'checks-assistant-ok': 'The assistant answered through {{mode}}: «{{reply}}».',
  'checks-cli-found': 'The command {{command}} was found in PATH.',
  'checks-cli-missing':
    'The CLI binary was not found in PATH. The configuration sections are not broken by this — only starting the assistant through the CLI is limited.',
  'checks-config-undeclared': 'The provider declares no configuration location.',
  'checks-config-missing':
    "None of the configuration paths were found ({{paths}}). They usually appear after the CLI's first run.",
  'checks-config-present': 'The configuration is in place: {{paths}}.',
  'checks-format-rejected': 'The file format was not accepted: {{reason}}',
  'checks-mcp-reread-missing':
    'Writing the probe server succeeded, but on re-reading it is gone — the file format is not fully parsed.',
  'checks-mcp-neighbours':
    'After adding and removing the probe server the list differs from the original — writing changes neighbouring entries.',
  'checks-mcp-ok': 'The read-write cycle closed on a copy of the file, servers in it: {{count}}.',
  'checks-permissions-meaning':
    'Rewriting the permissions that were read changed their meaning — the format is not fully parsed.',
  'checks-permissions-ok':
    'The permissions were read and written back on a copy of the file without changing their meaning.',
  'checks-env-reread-missing':
    'The probe variable was written, but on re-reading it is gone — the format is not fully parsed.',
  'checks-env-set-differs':
    'After adding and removing the probe variable the set differs from the original.',
  'checks-env-ok': 'The read-write cycle closed on a copy of the file, variables in it: {{count}}.',
  'checks-instructions-unsupported': 'The instructions section is not supported for this provider.',
  'checks-instructions-cursor':
    "Cursor's instructions are a directory of `.mdc` rules; the write cycle is not run over a directory.",
  'checks-instructions-list-not-allowed': 'The instructions list is not permitted.',
  'checks-instructions-list-changed': 'Rewriting the list of links changed its contents.',
  'checks-instructions-list-ok':
    'The list of links was rewritten unchanged, entries in it: {{count}}.',
  'checks-instructions-undeclared': 'The provider declares no instructions file.',
  'checks-instructions-file-absent':
    'The file {{path}} does not exist yet — it appears once instructions are set.',
  'checks-instructions-file-ok':
    'The instructions file reads and writes back unchanged ({{count}} characters).',
  'checks-instructions-file-changed': 'Rewriting the instructions file changed its text.',
  'checks-instructions-file-unread': 'The file was not read: {{reason}}',
  'sandbox-event-bash-safe-title': 'A harmless command',
  'sandbox-event-bash-safe-description': 'An ordinary Bash call — the guard should not step in.',
  'sandbox-event-bash-destructive-title': 'Recursive deletion',
  'sandbox-event-bash-destructive-description':
    'A dangerous command — the guard over destructive operations should stop it.',
  'sandbox-event-git-push-title': 'A mutating git operation',
  'sandbox-event-git-push-description':
    'A push to the remote repository — by the rules the agent must not do this.',
  'sandbox-event-write-secret-title': 'Writing a secret into a file',
  'sandbox-event-write-secret-description':
    'The content holds a token-shaped key — the secrets guard should step in.',
  'sandbox-event-write-placeholder-title': 'A placeholder key in an example',
  'sandbox-event-write-placeholder-description':
    'A placeholder value in .env.example — the guard should not interfere.',
  'sandbox-event-write-plain-title': 'An ordinary file edit',
  'sandbox-event-write-plain-description':
    'An edit to a source file — auto-formatting is usually hung here.',
  'sandbox-event-prompt-figma-title': 'A request with a Figma link',
  'sandbox-event-prompt-figma-description': "Hints on the user's input fire here.",
  'sandbox-event-session-start-title': 'Session start',
  'sandbox-event-session-start-description': 'Briefings and reminders at the start.',
  'sandbox-event-stop-title': 'End of the answer',
  'sandbox-event-stop-description': "Checks that run after the model's answer.",
  'sandbox-event-bad-json': "The JSON did not parse: check the event's syntax.",
  'sandbox-event-not-object':
    'The event must be a JSON object of the form {"hook_event_name": "…"}.',
};
