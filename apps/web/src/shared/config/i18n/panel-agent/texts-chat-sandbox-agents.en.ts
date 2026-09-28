import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту держит
 * тип словаря у места вливания.
 */
type ChatSandboxAgentsTexts = { [C in PanelTextCode]?: string };

/**
 * English texts of the P3 actions (continuing a chat in a new session, chat files, open in the
 * editor, the sandbox, contour agents and embeddings), merged into `panelTextsEn` by one spread.
 */
export const panelTextsChatSandboxAgentsEn = {
  'journal-continue-chat-handoff': 'Continuing a chat in a new session',
  'journal-restart-chat-session': 'Restarting a chat session',
  'journal-list-chat-artifacts': 'Chat files',
  'journal-read-chat-artifact': 'Reading a chat file',
  'journal-delete-chat-artifact': 'Deleting a chat file',
  'journal-open-in-editor': 'Opening a project in the editor',
  'summary-continue-chat-handoff':
    'Continue chat «{{title}}» in a new session as the agent proposed',
  'summary-restart-chat-session': 'Restart the session of chat «{{title}}»',
  'summary-delete-chat-artifact': 'Delete file «{{name}}» from chat «{{title}}»',
  'summary-open-in-editor': 'Open project «{{name}}» in the editor',
  'label-handoff-done': 'Done',
  'label-handoff-next': 'Next',
  'label-handoff-checkpoint': 'Checkpoint file',
  'label-artifact-size': 'Size and date',
  'label-editor': 'Editor',
  'value-restart-how':
    'If {{checkpoint}} is fresher than your last message, the new session starts at once; otherwise the chat updates it first, and the continuation starts by itself when that turn ends',
  'journal-list-sandbox-fixtures': 'Sandbox event fixtures',
  'journal-sandbox-probe-hook': 'Hook run in the sandbox',
  'journal-sandbox-ask': 'Question to Claude in the sandbox',
  'summary-sandbox-probe-hook': 'Run «{{name}}» in the sandbox',
  'summary-sandbox-ask': 'Ask Claude in the sandbox with the chosen settings',
  'label-sandbox-events': 'Events',
  'label-sandbox-question': 'Question',
  'label-sandbox-rules': 'Rules',
  'label-sandbox-skills': 'Skills',
  'label-sandbox-hooks': 'Hooks',
  'label-sandbox-mcp': 'MCP servers',
  'label-sandbox-scripts': 'Scripts',
  'label-sandbox-draft-rule': 'Draft rule',
  'value-sandbox-events-all': 'All fixtures',
  'value-sandbox-cleanup':
    'The command runs on this computer over a copy in a temporary folder; the real settings do not change, and the folder is removed right after the run',
  'value-sandbox-empty': 'Nothing: Claude without your settings, for comparison',
  'value-sandbox-ask-how':
    'Claude Code starts with a temporary config of only what was chosen and spends the subscription limit; the copy of account access is removed right after the answer',
  'journal-ask-contour-agent': 'Question to a contour agent',
  'journal-read-contour-agent-session': 'Reading a contour agent session',
  'journal-reset-contour-agent-session': 'Resetting a contour agent session',
  'journal-contour-embeddings': 'Contour embeddings',
  'summary-ask-contour-agent': 'Ask agent {{name}} of contour «{{title}}»',
  'summary-reset-contour-agent-session': 'Reset session «{{name}}» at contour «{{title}}»',
  'summary-contour-embeddings': 'Compute embeddings with model {{name}} at contour «{{title}}»',
  'label-contour-agent': 'Agent',
  'label-contour-question': 'Question',
  'label-contour-session': 'Session',
  'label-contour-model': 'Model',
  'label-contour-texts': 'Texts',
  'value-contour-session-none': 'No session: the agent will not remember this conversation',
  'value-contour-agent-spends':
    'The agent answers at the contour and spends its budget; it may use the tools the company gave it',
  'value-contour-session-forget':
    'The contour forgets the whole conversation of this session, for every agent; cannot be undone',
  'value-contour-embeddings-spend':
    'The request goes to the contour and spends its budget; the agent gets back only the number of vectors and their size',
} satisfies ChatSandboxAgentsTexts;
