import type { panelActionsGroupsEntitiesRu } from './actions-groups-entities.ru.ts';

/** Английские названия действий над группами и сущностями (U5a); ключи — по русскому модулю. */
export const panelActionsGroupsEntitiesEn: Record<
  keyof typeof panelActionsGroupsEntitiesRu,
  string
> = {
  list_discovered_groups: 'Discovered resource sets',
  run_group_discovery: 'Search for resource sets again',
  import_discovered_group: 'Make a discovered set a group',
  copy_group_to_global: 'Copy a group to global',
  apply_group_advice: 'Apply advice to a group copy',
  merge_group_origin: 'Merge a group copy with its original',
  read_group_override: 'Group override in a project',
  set_group_override: 'Turn a group override on or off',
  activate_groups_for_path: 'Switch on the groups of a folder',
  list_resource_catalog: 'Catalog of ready resources',
  draft_group_step: 'Draft a path step',
  promote_group_step: 'Turn a path step into a resource',
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
