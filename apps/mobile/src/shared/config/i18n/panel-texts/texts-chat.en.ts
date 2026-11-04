import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг. Полноту держит тип словаря у места вливания.
 */
type ChatTexts = { [C in PanelTextCode]?: string };

/**
 * English texts of the agent's chat actions (read, write, ask for a split, keep working here, chat
 * group, stop, split and tree controls, waiting items, search), merged into `panelTextsEn` by one
 * spread.
 */
export const panelTextsChatEn = {
  'journal-read-chat': 'Reading a chat',
  'journal-search-chats': 'Searching chats',
  'journal-list-waiting': 'What waits for the human in chats',
  'journal-list-chat-projects': 'Folders that have chats',
  'journal-send-chat-message': 'Message to a chat',
  'journal-stop-chat-run': 'Stopping the agent in a chat',
  'journal-split-control': 'Controlling a task split',
  'summary-send-chat-message': 'Send a message to chat “{{chat}}”',
  'summary-stop-chat-run': 'Stop the agent in chat “{{chat}}”',
  'summary-tree-pause': 'Stop the whole tree of chat “{{chat}}”',
  'summary-tree-resume': 'Resume the whole tree of chat “{{chat}}”',
  'label-chat': 'Chat',
  'label-message': 'Message',
  'label-effort': 'Thinking depth',
  'label-chat-state': 'Chat agent',
  'value-chat-busy-queued': 'Working now — the message goes when it finishes the turn',
  'value-chat-idle': 'Idle — the message goes at once',
  'value-stop-run': 'The turn is cut off; the agent will not finish what it started',
  'value-tree-pause-effect': 'Every run of this request stops, auto-starts freeze',
  'value-tree-resume-effect': 'Stopped conversations continue, deferred messages go out',
} satisfies ChatTexts;
