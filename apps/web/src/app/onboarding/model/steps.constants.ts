import type { Step } from '../OnboardingWizard.types';

/**
 * Порядок шагов мастера первого запуска — единственное место, где он задан.
 * Кнопки «Назад»/«Далее», счётчик «Шаг N из M» и восстановление после F5
 * считаются от этого списка, поэтому новый шаг добавляется одной строкой.
 */
export const STEP_ORDER: readonly Step[] = ['intro', 'location', 'providers', 'access'];

/** Ключ sessionStorage: F5 посреди мастера возвращает на тот же шаг, новая вкладка — на первый. */
export const STEP_STORAGE_KEY = 'agentdeck:onboarding-step';
