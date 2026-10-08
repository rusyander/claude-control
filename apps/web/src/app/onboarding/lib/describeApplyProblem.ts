import type { ClaudeLocation } from '@agentdeck/contracts';
import { serverFieldText } from '@shared/config/i18n';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/** Причина отказа — у поля: текст сервера для непринятого пути, иначе ошибка запроса. */
export function describeApplyProblem(
  result: ClaudeLocation | undefined,
  error: unknown,
  fallback: string,
): string | undefined {
  if (result && !result.isValid)
    return result.problem ? serverFieldText(result, 'problem') : fallback;
  if (error) return toErrorMessage(error);
  return undefined;
}
