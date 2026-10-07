import type { Step } from '../OnboardingWizard.types';

/**
 * Порядок шагов мастера первого запуска — единственное место, где он задан.
 * Кнопки «Назад»/«Далее», счётчик «Шаг N из M» и восстановление после F5
 * считаются от этого списка, поэтому новый шаг добавляется одной строкой.
 */
export const STEP_ORDER: readonly Step[] = ['intro', 'location', 'providers', 'access'];

/** Ключ sessionStorage: F5 посреди мастера возвращает на тот же шаг, новая вкладка — на первый. */
export const STEP_STORAGE_KEY = 'agentdeck:onboarding-step';

export function isStep(value: unknown): value is Step {
  return typeof value === 'string' && (STEP_ORDER as readonly string[]).includes(value);
}

/**
 * Шаги для выбранного провайдера. «Доступ Claude Code» нужен только Claude: у
 * другого CLI свой вход, и шаг про чужой доступ читался как обязательный.
 * Провайдер не известен — полный список: по умолчанию панель работает с Claude.
 */
export function stepOrder(providerId: string | undefined): readonly Step[] {
  if (!providerId || providerId === 'claude') return STEP_ORDER;
  return STEP_ORDER.filter((step) => step !== 'access');
}

/** Шаг, которого в списке нет (сохранён до смены провайдера), — последний из оставшихся. */
export function fitStep(step: Step, order: readonly Step[]): Step {
  return order.includes(step) ? step : (order[order.length - 1] ?? step);
}

/** Номер шага для человека: с единицы. */
export function stepNumber(step: Step, order: readonly Step[] = STEP_ORDER): number {
  return order.indexOf(step) + 1;
}

export function nextStep(step: Step, order: readonly Step[] = STEP_ORDER): Step | undefined {
  return order[order.indexOf(step) + 1];
}

export function prevStep(step: Step, order: readonly Step[] = STEP_ORDER): Step | undefined {
  const index = order.indexOf(step);
  return index > 0 ? order[index - 1] : undefined;
}

/**
 * С какого шага открыть мастер.
 *
 * Онбординг уже пройден, но каталог конфигурации стал невалидным — мастер
 * вернулся только ради каталога: сразу шаг каталога, без «Добро пожаловать».
 * Иначе — шаг, сохранённый до перезагрузки, а если его нет — первый.
 */
export function initialStep(input: { onboardingDone: boolean; stored: unknown }): Step {
  if (input.onboardingDone) return 'location';
  return isStep(input.stored) ? input.stored : 'intro';
}

/** Хранилище может быть недоступно (приватный режим, отключённые данные сайта) — тогда молчим. */
type StepStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readStoredStep(storage: StepStorage | undefined): Step | undefined {
  try {
    const value = storage?.getItem(STEP_STORAGE_KEY);
    return isStep(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeStep(storage: StepStorage | undefined, step: Step): void {
  try {
    storage?.setItem(STEP_STORAGE_KEY, step);
  } catch {
    // Нет хранилища — после F5 мастер просто начнётся с первого шага.
  }
}

export function clearStoredStep(storage: StepStorage | undefined): void {
  try {
    storage?.removeItem(STEP_STORAGE_KEY);
  } catch {
    // См. storeStep.
  }
}

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

/** Найден ли в PATH CLI, отличный от Claude Code, — повод не требовать `.claude`. */
export function hasOtherCli(
  detect: { providers: readonly { id: string; cliInstalled: boolean }[] } | undefined,
): boolean {
  return detect?.providers.some((item) => item.id !== 'claude' && item.cliInstalled) ?? false;
}
