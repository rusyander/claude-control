import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту держит
 * тип словаря у места вливания.
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
  'journal-request-split': 'Asking a chat to split its tasks',
  'journal-split-decline': 'Declining the task split',
  'journal-set-chat-group': 'Chat group and autonomy',
  'journal-stop-chat-run': 'Stopping the agent in a chat',
  'journal-split-control': 'Controlling a task split',
  'summary-send-chat-message': 'Send a message to chat “{{chat}}”',
  'summary-request-split': 'Ask chat “{{chat}}” to propose splitting its tasks across chats',
  'summary-split-decline': 'Chat “{{chat}}”: keep working here, stop proposing a split',
  'summary-set-chat-group': 'Change the group or autonomy of chat “{{chat}}”',
  'summary-stop-chat-run': 'Stop the agent in chat “{{chat}}”',
  'summary-split-pause': 'Pause group “{{group}}” (chat “{{chat}}”)',
  'summary-split-resume': 'Resume group “{{group}}” after the pause (chat “{{chat}}”)',
  'summary-split-release':
    'Release group “{{group}}” without waiting for its predecessors (chat “{{chat}}”)',
  'summary-split-answer': 'Answer the triage question of group “{{group}}” (chat “{{chat}}”)',
  'summary-tree-pause': 'Stop the whole tree of chat “{{chat}}”',
  'summary-tree-resume': 'Resume the whole tree of chat “{{chat}}”',
  'label-chat': 'Chat',
  'label-message': 'Message',
  'label-effort': 'Thinking depth',
  'label-chat-state': 'Chat agent',
  'label-autonomous': 'Autonomy',
  'label-answer': 'Answer',
  'label-question': 'Question',
  'value-split-request-standard':
    'The standard split request — the same as the “Split tasks across chats” button',
  'value-split-next-human':
    'The chat agent proposes groups; a “Split into … chats” button appears under its answer — you press it',
  'value-chat-busy-queued': 'Working now — the message goes when it finishes the turn',
  'value-chat-idle': 'Idle — the message goes at once',
  'value-group-auto': 'Auto',
  'value-group-inherit': 'Same as the parent chat',
  'value-autonomous-on': 'On',
  'value-autonomous-off': 'Off',
  'value-autonomous-inherit': 'Same as the parent chat',
  'value-stop-run': 'The turn is cut off; the agent will not finish what it started',
  'value-stop-pauses-group': 'This is a split group chat — the group will be paused',
  'value-split-decline-effect':
    'The chat agent will not propose a split on its own again; the “Split tasks across chats” button still works',
  'value-split-pause-effect': 'The group’s runs stop; the group waits for “Resume”',
  'value-split-resume-effect': 'The group continues in its own session',
  'value-split-requeue-effect':
    'The group was queued — it goes back to the queue and starts when its turn comes',
  'value-split-resume-fresh-effect':
    'The group has no session yet — it starts in its copy, or sets the copy up afresh',
  'value-split-pause-queued-effect':
    'The queued group will not start until resumed; it holds no slot',
  'value-split-release-effect': 'The group starts now, merging nothing from its predecessors',
  'value-split-answer-effect': 'The answer goes to the group, and it starts',
  'value-tree-pause-effect': 'Every run of this request stops, auto-starts freeze',
  'value-tree-resume-effect': 'Stopped conversations continue, deferred messages go out',
} satisfies ChatTexts;
