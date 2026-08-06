import type { DlpHit, DlpRule } from '@claude-control/contracts';
import { mapBodyTexts, type DlpApiKind } from './api-shapes.ts';
import { maskText, mergeHits, type AliasVault } from './mask.ts';

/**
 * Исходящий запрос: заменить найденное на метки — либо отклонить целиком.
 *
 * Правило с действием «отклонить» срабатывает раньше любых замен: если в
 * запросе есть то, чего наружу быть не должно вовсе, отправлять его частично
 * замаскированным бессмысленно.
 */

export interface MaskedRequest {
  /** Тело для отправки наверх; при отказе — исходное, оно никуда не пойдёт. */
  body: string;
  hits: DlpHit[];
  blockedBy?: { ruleId: string; ruleName: string };
}

export function maskRequestBody(
  raw: string,
  kind: DlpApiKind,
  rules: readonly DlpRule[],
  vault: AliasVault,
): MaskedRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Не JSON — форма неизвестна. Решение принимает вызывающий (fail-closed).
    return undefined;
  }

  const groups: DlpHit[][] = [];
  let blockedBy: MaskedRequest['blockedBy'];

  const masked = mapBodyTexts(parsed, kind, (text) => {
    const result = maskText(text, rules, vault);
    groups.push(result.hits);
    if (result.blockedBy && !blockedBy) blockedBy = result.blockedBy;
    return result.text;
  });

  const hits = mergeHits(groups);
  if (blockedBy) return { body: raw, hits, blockedBy };
  return { body: JSON.stringify(masked), hits };
}
