import { object, string, array, enum as zodEnum, type infer as Infer } from 'zod';

/** Решение по инструменту. Приоритет в Claude Code: deny > ask > allow. */
export const permissionDecisionSchema = zodEnum(['allow', 'ask', 'deny']);
export type PermissionDecision = Infer<typeof permissionDecisionSchema>;

export const permissionRuleSchema = object({
  id: string(),
  /** Сырой паттерн, например `mcp__gitlab-gorgona__get_project` или `Bash(git push:*)`. */
  pattern: string(),
  decision: permissionDecisionSchema,
  /** Для правил MCP — имя сервера, вытащенное из паттерна. Помогает группировать список. */
  mcpServer: string().optional(),
  /** Для правил MCP — имя инструмента. */
  mcpTool: string().optional(),
  groupIds: array(string()),
});

export type PermissionRule = Infer<typeof permissionRuleSchema>;

export const permissionDraftSchema = object({
  pattern: string().min(1),
  decision: permissionDecisionSchema,
  groupIds: array(string()).default([]),
});

export type PermissionDraft = Infer<typeof permissionDraftSchema>;
