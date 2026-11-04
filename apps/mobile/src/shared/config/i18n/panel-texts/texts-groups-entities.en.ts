import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * English texts of the agent's actions over groups by scope and over entities
 * beyond their list (skill rename, hook/env/permission move, permission edit,
 * MCP health and tools, skill files and templates). Merged into `panelTextsEn`
 * with one spread.
 */
export const panelTextsGroupsEntitiesEn = {
  'journal-rename-skill': 'Skill rename',
  'journal-move-hook': 'Hook reorder',
  'journal-move-env': 'Environment variable moved to the other file',
  'journal-move-permission': 'Permission moved to the other file',
  'journal-edit-permission': 'Permission edit',
  'journal-check-mcp-health': 'MCP server connection check',
  'journal-list-mcp-tools': 'MCP server tools',
  'journal-list-skill-templates': 'Skill structure templates',
  'journal-apply-skill-template': 'Structure template into a skill',
  'journal-list-skill-files': 'Skill files',
  'journal-read-skill-file': 'Skill file',
  'journal-save-skill-file': 'Skill file write',
  'journal-delete-skill-file': 'Skill file deletion',
  'journal-move-skill-file': 'File move inside a skill',
  'summary-rename-skill': 'Rename skill «{{from}}» to «{{to}}»',
  'summary-move-hook-up': 'Move a {{event}} hook one place up',
  'summary-move-hook-down': 'Move a {{event}} hook one place down',
  'summary-move-env': 'Move variable {{key}} to {{to}}',
  'summary-move-permission': 'Move permission {{pattern}} to {{to}}',
  'summary-edit-permission': 'Edit permission {{pattern}}',
  'summary-check-mcp-health': 'Check the connection to MCP server «{{name}}»',
  'summary-list-mcp-tools': 'Ask MCP server «{{name}}» for its tool list',
  'summary-apply-skill-template': 'Add the files of template «{{template}}» to skill «{{skill}}»',
  'summary-save-skill-file-create': 'Create file {{file}} in skill «{{skill}}»',
  'summary-save-skill-file-update': 'Change file {{file}} in skill «{{skill}}»',
  'summary-delete-skill-file': 'Delete file {{file}} from skill «{{skill}}»',
  'summary-move-skill-file': 'Move {{from}} to {{to}} inside skill «{{skill}}»',
  'label-target-file': 'Where to',
  'label-hook-order': 'Hook order of the event',
  'label-template-files': 'Template files',
  'value-happens-mcp-spawn':
    'The panel starts the server (or calls its address) and talks to it over the MCP protocol',
  'value-happens-template': 'Existing skill files are not touched — only missing ones are added',
} satisfies Partial<Record<PanelTextCode, string>>;
