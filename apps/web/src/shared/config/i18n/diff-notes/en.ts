import type { diffNotesRu } from './ru.ts';

/** Notes on changed lines in the project code window; typed against the Russian module. */
export const diffNotesEn: typeof diffNotesRu = {
  title: 'Notes on changes',
  gutterLabel: 'Note on this line',
  addAtCursor: 'Note',
  addAtCursorHint: 'Note on the line under the cursor',
  draftLabel: 'Note on line {{place}}',
  draftPlaceholder: 'What should change in this line?',
  draftHint: 'Ctrl+Enter adds',
  add: 'Add',
  update: 'Update',
  cancel: 'Cancel',
  remove: 'Remove note {{place}}',
  count: 'Notes: {{count}}',
  now: 'Now',
  queue: 'Queue',
  clear: 'Clear',
  hintLive: 'The agent is working: «Now» goes mid-turn, «Queue» goes as the next turn.',
  hintIdle: 'The agent is idle: the notes go as one message.',
  messageHeader: 'Notes on changes ({{count}}):',
  emptyLine: '(empty line)',
};
