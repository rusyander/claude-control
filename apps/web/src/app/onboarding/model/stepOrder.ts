import type { Step } from '../OnboardingWizard.types';
import { STEP_ORDER } from './steps.constants';

/**
 * Шаги для выбранного провайдера. «Доступ Claude Code» нужен только Claude: у
 * другого CLI свой вход, и шаг про чужой доступ читался как обязательный.
 * Провайдер не известен — полный список: по умолчанию панель работает с Claude.
 */
export function stepOrder(providerId: string | undefined): readonly Step[] {
  if (!providerId || providerId === 'claude') return STEP_ORDER;
  return STEP_ORDER.filter((step) => step !== 'access');
}
