import type { projectsPageRu } from './ru.ts';

/** English texts of the «Projects — configuration» section; typed against the Russian module. */
export const projectsPageEn: typeof projectsPageRu = {
  subtitle:
    "One repository's instructions, MCP servers and permissions are edited here; its own .claude is read-only",
  registryLabel: 'Added projects',
  tabsLabel: 'Project sections',
  tab: {
    instructions: 'Instructions',
    mcp: 'MCP servers',
    permissions: 'Permissions',
    local: 'From the project',
  },
  unsaved: 'unsaved',
  localCountHint: 'skills: {{skills}}, hooks: {{hooks}}, rules: {{rules}}',
  editable: 'edited here',
  readOnly: 'read-only',
  hint: {
    mcp: 'Servers from .mcp.json in the project root: added, edited and switched off here. Claude Code connects them in sessions of this directory.',
    permissions:
      'The project’s access rules. An entry marked “local” lives in settings.local.json, which is usually not committed.',
    local:
      'Skills, hooks and rules from the repository itself. Claude Code loads them together with yours; they are edited in the repository — in an editor and with a commit.',
  },
  doc: {
    edit: 'Edit',
    preview: 'Preview',
    editorLabel: '{{file}} text',
    previewLabel: '{{file}} contents',
    emptyFile: 'The file is empty. Press “Edit” to write instructions.',
    noFileTitle: 'The project has no {{file}} yet',
    noFileText:
      'The file appears on the first save. Until then only your personal instructions apply in this project.',
    createFile: 'Write {{file}}',
    saveHint: 'Ctrl+S — save',
    changedElsewhere:
      '{{file}} changed outside the panel while you were editing (an agent may have written it). “Save” replaces that text with yours, “Revert changes” shows the new one.',
  },
};
