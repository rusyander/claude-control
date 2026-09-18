/** Коды текстов сервера, раздел «sandbox»: Песочница. Сборка всех — `../server-messages.ts`. */
export const sandboxMessageParams = {
  'sandbox-unspecified': [],
  'sandbox-not-built': [],
  'sandbox-hook-script-missing': [],
  'sandbox-script-name-invalid': [],
  'sandbox-script-missing': [],
  'sandbox-ask-incomplete': [],
  'sandbox-reaped-idle': [],
  'sandbox-nothing-to-run': [],
  'sandbox-ps1-needs-pwsh': [],
  'sandbox-hook-exit-2': [],
  'sandbox-hook-no-decision': ['code'],
  'sandbox-hook-not-started': [],
  'sandbox-wipe-failed': ['reason'],
  'sandbox-remove-failed': ['path', 'reason'],
} as const satisfies Record<string, readonly string[]>;
