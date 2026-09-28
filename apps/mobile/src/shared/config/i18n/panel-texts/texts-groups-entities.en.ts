import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * English texts of the agent's actions over groups by scope and over entities
 * beyond their list (skill rename, hook/env/permission move, permission edit,
 * MCP health and tools, skill files and templates). Merged into `panelTextsEn`
 * with one spread.
 */
export const panelTextsGroupsEntitiesEn = {
  'journal-list-discovered-groups': 'Discovered resource sets',
  'journal-run-group-discovery': 'Resource set discovery',
  'journal-import-discovered-group': 'Import a discovered set as a group',
  'journal-copy-group-to-global': 'Copy a project group to global',
  'journal-apply-group-advice': 'Apply advice to a group copy',
  'journal-merge-group-origin': 'Merge a group copy with its original',
  'journal-read-group-override': 'Group override in a project',
  'journal-set-group-override': 'Turn a group override on or off',
  'journal-activate-groups': 'Switch on groups bound to a folder',
  'journal-list-resource-catalog': 'Catalog of ready resources for groups',
  'journal-draft-group-step': 'Path step draft from the assistant',
  'journal-promote-group-step': 'Path step becomes a resource',
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
  'summary-run-group-discovery':
    'Find resource sets in projects and CLI folders ({{sources}} sources)',
  'summary-import-discovered-group': 'Make the discovered set «{{name}}» a project group',
  'summary-copy-group-to-global': 'Copy group «{{name}}» to global',
  'summary-apply-group-advice': 'Apply advice to the global copy «{{name}}»',
  'summary-merge-group-origin': 'Propose a merge of copy «{{name}}» with its updated original',
  'summary-group-override-on': 'Turn on the override of group «{{name}}» in the project',
  'summary-group-override-off': 'Turn off the override of group «{{name}}» in the project',
  'summary-activate-groups': 'Switch on the groups bound to {{path}}',
  'summary-promote-group-step': 'Make step «{{step}}» a resource of its own',
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
  'label-found-in': 'Found in',
  'label-advice-items': 'Advice to apply',
  'label-resource-type': 'Resource type',
  'label-target-file': 'Where to',
  'label-hook-order': 'Hook order of the event',
  'label-template-files': 'Template files',
  'value-happens-discovery':
    'The model reads the inventory of every source — this spends quota; your files do not change, the result shows in «Groups»',
  'value-happens-copy-global':
    'Members are copied to the global folders (a taken name gets a suffix), then the model gives advice — this spends quota',
  'value-happens-merge':
    'The model compares the copy with the original and proposes edits — this spends quota; files change only after «Apply advice»',
  'value-happens-override-on':
    'The model writes rule {{file}} in the project (hidden from git); the group’s global skills are denied in the project',
  'value-happens-override-off':
    'File {{file}} and the panel’s denies are removed — the project is as it was',
  'value-happens-activate': 'Bound groups are only switched on; enabled ones stay as they are',
  'value-happens-mcp-spawn':
    'The panel starts the server (or calls its address) and talks to it over the MCP protocol',
  'value-happens-template': 'Existing skill files are not touched — only missing ones are added',
  'value-import-left-out': 'Stay out: {{members}}',
  'summary-draft-group-step': 'Ask the path-step assistant of group «{{group}}»',
  'value-happens-draft-step':
    'The model drafts the step from your words — this spends quota; the group does not change, the assistant’s conversation is kept in the panel’s data, as with the «Assistant» button',
} satisfies Partial<Record<PanelTextCode, string>>;
