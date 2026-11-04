import type { panelActionsGroupsEntitiesRu } from './actions-groups-entities.ru.ts';

/** Английские названия действий над группами и сущностями (U5a); ключи — по русскому модулю. */
export const panelActionsGroupsEntitiesEn: Record<
  keyof typeof panelActionsGroupsEntitiesRu,
  string
> = {
  rename_skill: 'Rename a skill',
  move_hook: 'Move a hook',
  move_env: 'Move a variable to the other file',
  move_permission: 'Move a permission to the other file',
  edit_permission_rule: 'Edit a permission',
  check_mcp_health: 'Check an MCP server connection',
  list_mcp_tools: 'MCP server tools',
  list_skill_templates: 'Skill structure templates',
  apply_skill_template: 'Add a template to a skill',
  list_skill_files: 'Skill files',
  read_skill_file: 'Read a skill file',
  save_skill_file: 'Write a skill file',
  delete_skill_file: 'Delete a skill file',
  move_skill_file: 'Move a skill file',
};
