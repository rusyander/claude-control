import type { TFunction } from 'i18next';
import type { ApiSchemaIssue } from '@entities/ApiExplorer';

/**
 * Расхождение ответа со схемой → строка. Одна и та же строка идёт и в окно, и в
 * просьбу агенту: что человек видит, то агент и получает.
 */
export function issueText(issue: ApiSchemaIssue, t: TFunction): string {
  return t(`environment.api.response.issue.${issue.kind}`, {
    path: issue.path,
    expected: issue.expected ?? '',
    actual: issue.actual ?? '',
  });
}
