import type { ProviderSkillProblem } from '@claude-control/contracts';

/**
 * Причина «только для чтения» → суффикс ключа перевода. Держим маппинг в одном
 * месте: и список, и редактор скиллов показывают одну и ту же формулировку.
 */
export function skillProblemKey(problem: ProviderSkillProblem | undefined): string {
  return problem ?? 'malformed';
}
