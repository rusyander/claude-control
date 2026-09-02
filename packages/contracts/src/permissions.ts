import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';
import { settingsSourceSchema } from './settings-source';

/** Решение по инструменту. Приоритет в Claude Code: deny > ask > allow. */
export const permissionDecisionSchema = zodEnum(['allow', 'ask', 'deny']);
export type PermissionDecision = Infer<typeof permissionDecisionSchema>;

export const permissionRuleSchema = object({
  /** У прав из локального файла — с префиксом `local:`: без него совпал бы с одноимённым. */
  id: string(),
  /** Сырой паттерн, например `mcp__gitlab-gorgona__get_project` или `Bash(git push:*)`. */
  pattern: string(),
  decision: permissionDecisionSchema,
  /** Для правил MCP — имя сервера, вытащенное из паттерна. Помогает группировать список. */
  mcpServer: string().optional(),
  /** Для правил MCP — имя инструмента. */
  mcpTool: string().optional(),
  groupIds: array(string()),
  /** Из какого файла настроек прочитано право; локальные — только на чтение. */
  source: settingsSourceSchema,
  /**
   * Выключенного права в файле нет — Claude Code применял бы его. Оно хранится
   * отметкой в состоянии панели (ручной или групповой) и подмешивается в список
   * с `false`: иначе право, погашенное группой, просто исчезало бы со своей
   * страницы, и вернуть его было бы нечем.
   */
  isEnabled: boolean(),
});

export type PermissionRule = Infer<typeof permissionRuleSchema>;

export const permissionDraftSchema = object({
  pattern: string().min(1),
  decision: permissionDecisionSchema,
  groupIds: array(string()).default([]),
});

export type PermissionDraft = Infer<typeof permissionDraftSchema>;
