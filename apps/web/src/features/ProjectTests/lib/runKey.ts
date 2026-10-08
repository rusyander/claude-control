/** Подпись прогона одним ключом словаря: вложенные тернарники здесь запрещены. */
export const RUNNING_KEY: Record<string, string> = {
  generate: 'projectTests.runGenerate',
  explore: 'projectTests.runExplore',
  automate: 'projectTests.runAutomate',
};

export function runKey(status: string, mode: string): string {
  // У каждого режима агента своя подпись: «Прогон идёт» над исследованием или
  // автоматизацией обещал галочки в библиотеке, которых этот режим не ставит.
  if (status === 'running') return RUNNING_KEY[mode] ?? 'projectTests.running';
  if (status === 'stopped') return 'projectTests.runStopped';
  if (status === 'error') return 'projectTests.runError';
  return 'projectTests.runDone';
}
