import type { Step } from '../OnboardingWizard.types';

/**
 * Порядок шагов мастера первого запуска — единственное место, где он задан.
 * Кнопки «Назад»/«Далее», счётчик «Шаг N из M» и восстановление после F5
 * считаются от этого списка, поэтому новый шаг добавляется одной строкой.
 */
export const STEP_ORDER: readonly Step[] = ['intro', 'location', 'providers', 'access'];

/** Ключ sessionStorage: F5 посреди мастера возвращает на тот же шаг, новая вкладка — на первый. */
export const STEP_STORAGE_KEY = 'claude-control:onboarding-step';

export function isStep(value: unknown): value is Step {
  return typeof value === 'string' && (STEP_ORDER as readonly string[]).includes(value);
}

/** Номер шага для человека: с единицы. */
export function stepNumber(step: Step): number {
  return STEP_ORDER.indexOf(step) + 1;
}

export function nextStep(step: Step): Step | undefined {
  return STEP_ORDER[STEP_ORDER.indexOf(step) + 1];
}

export function prevStep(step: Step): Step | undefined {
  const index = STEP_ORDER.indexOf(step);
  return index > 0 ? STEP_ORDER[index - 1] : undefined;
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
