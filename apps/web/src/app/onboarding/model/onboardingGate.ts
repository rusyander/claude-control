/**
 * Что мастер разрешает при данном каталоге Claude и выбранном провайдере.
 *
 * Каталог `.claude` обязателен только тому, кто работает с Claude Code. Выбран
 * другой провайдер — панели есть что показывать и без него (её данные лежат в
 * `~/.agentdeck/data`). Выбран ещё Claude, но в PATH есть другой CLI — с шага
 * каталога можно уйти на шаг выбора CLI; «Готово» — только когда выбор сделан.
 * Без каталога и без другого CLI мастер по-прежнему держит на шаге каталога.
 */
export function onboardingGate(input: {
  isValid: boolean;
  activeProviderId: string;
  otherCliFound: boolean;
}): { panelReady: boolean; canLeaveLocation: boolean } {
  const panelReady = input.isValid || input.activeProviderId !== 'claude';
  return { panelReady, canLeaveLocation: panelReady || input.otherCliFound };
}
