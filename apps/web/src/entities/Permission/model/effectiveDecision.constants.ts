import type { PermissionDecision } from '@agentdeck/contracts';

/** Сила решения: deny перебивает ask, ask — allow. Так разбирает Claude Code. */
export const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };
