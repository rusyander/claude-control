import type { ProjectTestPointResult } from '@agentdeck/contracts';
import { isRed } from './isRed';

/**
 * Красный проход, не доказанный НИЧЕМ: ни снимка, ни разбора (шаг или что
 * вышло). По разбору с шагом провал воспроизводится и без картинки — пометка
 * «нет доказательства» рядом с «шаг 2» противоречила сама себе.
 */
export function isUnproven(result: ProjectTestPointResult): boolean {
  if (!isRed(result.status)) return false;
  if ((result.attachments ?? []).length > 0) return false;
  return result.failure?.step === undefined && !result.failure?.actual;
}
