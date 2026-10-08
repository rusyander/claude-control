import type { PathStep } from '@agentdeck/contracts';

/** Обе стороны промпта заполнены: только такой шаг уходит в прогон (он читает `prompt.en`). */
export function isBilingual(step: Pick<PathStep, 'prompt'>): boolean {
  return step.prompt.ru.trim().length > 0 && step.prompt.en.trim().length > 0;
}
