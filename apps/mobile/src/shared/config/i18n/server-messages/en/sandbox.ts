import type { SandboxMessageCode } from '@agentdeck/contracts/server-messages';

export const sandboxEn: Record<SandboxMessageCode, string> = {
  'sandbox-unspecified': 'No sandbox specified',
  'sandbox-not-built': 'The sandbox is not built yet: wait for the build to finish and run again.',
  'sandbox-hook-script-missing':
    "This hook's script did not make it into the sandbox — the run is cancelled so the real file is not executed. Build the sandbox again.",
  'sandbox-script-name-invalid': 'Invalid script name',
  'sandbox-script-missing':
    'The script did not make it into the sandbox — the run is cancelled so the real file is not executed. Build the sandbox again.',
  'sandbox-ask-incomplete': 'A sandbox and the question text are required',
  'sandbox-reaped-idle':
    'The sandbox was removed for idling: a copy of account access must not lie in it for hours. Open it again — it will be assembled again.',
  'sandbox-nothing-to-run': 'Nothing to run: command not found',
  'sandbox-ps1-needs-pwsh':
    '.ps1 scripts run through PowerShell — outside Windows pwsh (PowerShell Core) is required. Install it or rewrite the hook as .sh or .mjs.',
  'sandbox-hook-exit-2': 'The hook exited with code 2',
  'sandbox-hook-no-decision': 'The hook finished with code {{code}} and returned no decision',
  'sandbox-hook-not-started': 'The hook did not start',
  'sandbox-wipe-failed': 'The previous sandbox was not cleared: {{reason}}',
  'sandbox-remove-failed':
    'The sandbox was not removed ({{reason}}). A copy of the account access stayed in it — delete the folder {{path}} by hand.',
};
