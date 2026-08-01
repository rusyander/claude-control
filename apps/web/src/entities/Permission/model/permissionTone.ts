import type { PermissionDecision } from '@claude-control/contracts';

/** Цвет плашки: тем, чем её красит дизайн-система. */
export type PermissionTone = 'success' | 'warning' | 'danger';

/** Риск готовой заготовки права: чем выше, тем тревожнее плашка. */
export const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

/** Решение по правилу: разрешено — зелёное, спросит — жёлтое, запрещено — красное. */
export const DECISION_TONE: Record<PermissionDecision, PermissionTone> = {
  allow: 'success',
  ask: 'warning',
  deny: 'danger',
};
