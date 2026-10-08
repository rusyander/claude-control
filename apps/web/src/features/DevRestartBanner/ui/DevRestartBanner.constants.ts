/** Сколько правленых файлов назвать по имени: дальше — только число. */
export const NAMED_FILES = 3;

export const WAITING_KEY = {
  runs: 'devRestart.waitingRuns',
  setup: 'devRestart.waitingSetup',
  checks: 'devRestart.waitingChecks',
  both: 'devRestart.waitingBoth',
} as const;
