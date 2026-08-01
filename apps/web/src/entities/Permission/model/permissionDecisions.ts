import type { PermissionDecision } from '@claude-control/contracts';

/**
 * Решения по правилу в порядке от разрешающего к запрещающему. Порядок значим:
 * им задаётся и порядок кнопок в формах прав — пользовательских, проектных и в
 * помощнике отбора инструментов MCP.
 */
export const PERMISSION_DECISIONS: PermissionDecision[] = ['allow', 'ask', 'deny'];
