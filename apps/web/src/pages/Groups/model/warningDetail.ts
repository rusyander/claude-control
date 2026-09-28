import { emitOutcomes, type EmitOutcome } from '@agentdeck/contracts/portable-emit';
import { outcomeLabelKey } from '@entities/Portability';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Виды участников, которые сервер кладёт в `detail` пропущенного при копии. */
const MEMBER_KINDS = new Set([
  'skill',
  'hook',
  'rule',
  'agent',
  'command',
  'mcp',
  'instructions',
  'permission',
  'group',
]);

const isOutcome = (detail: string): detail is EmitOutcome =>
  (emitOutcomes as readonly string[]).includes(detail);

/**
 * Причина из предупреждения копии в общие — словами интерфейса. Сервер кладёт
 * в `detail` код (`permission`, `project-relative`, `missing`, исход переноса
 * `not_transferable`…) или текст ошибки записи. Код человеку не говорит ничего
 * и в английском интерфейсе оставался бы русским/служебным; текст ошибки —
 * единственная правда о сбое, он идёт как есть.
 */
export function warningDetailText(detail: string, t: Translate): string {
  if (MEMBER_KINDS.has(detail)) {
    return t('groupSources.warningDetail_kind', {
      kind: t(`groupSources.kind_${detail}`),
    });
  }
  if (detail === 'project-relative') return t('groupSources.warningDetail_projectRelative');
  if (detail === 'missing') return t('groupSources.warningDetail_missing');
  if (isOutcome(detail)) return t(outcomeLabelKey(detail));
  return detail;
}
