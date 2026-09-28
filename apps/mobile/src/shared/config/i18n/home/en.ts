import type { HomeTexts } from './ru';

export const homeEn: HomeTexts = {
  tabChats: 'Projects & chats',
  homeTabA11y: (count: number) => `Home, ${count} waiting for an answer`,
  tabQuestions: 'Questions',
  tabQuestionsA11y: (count: number) =>
    count > 0 ? `Questions: ${count} waiting for an answer` : 'Questions: nothing waiting',
  newChat: 'New chat',
  allChats: 'All conversations',
  failed: 'The panel did not answer — showing the last data received',
  failedEmpty: 'The panel did not answer. Pull down to ask again.',
  retry: 'Retry',
  back: 'Back',
  status: { running: 'working', waiting: 'needs you', idle: 'quiet' },
  groupCounts: (waiting: number, running: number) =>
    [waiting > 0 ? `waiting: ${waiting}` : '', running > 0 ? `working: ${running}` : '']
      .filter(Boolean)
      .join(' · '),
  sandbox: 'Sandbox',
  age: (minutes: number) => {
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
  },
  asksBadge: (questions: number, permissions: number) =>
    [
      questions > 0 ? `${questions} ${questions === 1 ? 'question' : 'questions'}` : '',
      permissions > 0 ? `${permissions} ${permissions === 1 ? 'permission' : 'permissions'}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  activeEmpty: 'Nothing is running right now',
  activeEmptyHint:
    'Chats where an agent is working or waiting for you show up here, plus everything from the last day.',
  noQuestions: 'No questions',
  noQuestionsHint:
    'No agent is waiting. When one asks a question or needs a permission, its card appears here.',
  step: (current: number, total: number) => `${current} of ${total}`,
  openChat: 'Open chat',
  permission: 'Permission needed',
  branchGate: 'First edit in the main copy',
  branchGateHint:
    'The agent is about to edit files right in the main copy of the project. A separate copy with a branch can be made in the panel.',
  writeHere: 'Write here',
  dontWrite: 'Do not write',
  allow: 'Allow',
  deny: 'Deny',
  details: 'Details',
  hideDetails: 'Collapse',
  multiHint: 'You can pick several',
  other: 'Other',
  otherPlaceholder: 'Your own answer',
  otherApply: 'Done',
  otherMine: 'your answer',
  cancel: 'Cancel',
  next: 'Next',
  change: 'Change',
  send: 'Send',
  sendHint: (count: number) =>
    `All answers of this chat go together — ${count} ${count === 1 ? 'answer' : 'answers'}`,
  sendFailed: (reason: string) => (reason ? `Not sent: ${reason}` : 'Not sent'),
  more: (count: number) => `${count} more ${count === 1 ? 'question' : 'questions'} after this`,
  answered: {
    allow: 'Allowed',
    deny: 'Denied',
    here: 'Write here',
    stop: 'Do not write',
  },
  running: 'the agent is working — the answer goes when it finishes the turn',
};
