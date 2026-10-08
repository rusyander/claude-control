import { SPLIT_MAX_GROUPS } from '@agentdeck/contracts/task-split';

/** Число групп разом: целое от 1 до потолка групп, иначе — не сохраняем. */
export function parseParallel(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return value >= 1 && value <= SPLIT_MAX_GROUPS ? value : undefined;
}
