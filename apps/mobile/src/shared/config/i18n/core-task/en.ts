import type { coreTaskRu } from './ru';

export const coreTaskEn: typeof coreTaskRu = {
  listTitle: 'Core tasks',
  taskTitle: 'Core task',
  untitled: 'Untitled task',
  empty: 'The core has no tasks.',
  live: 'running',
  ended: 'ended',
  attention: 'needs a human',
  waiting: (count: number) => `questions: ${count}`,
  // «Waiting for you» on the Questions tab (stage 12): only tasks a blocking question holds.
  waitingTitle: (count: number) => `Core tasks waiting for you: ${count}`,
  waitingHint:
    'Without your answer they will not go on. Questions with a default action are not listed — the task goes on by itself.',
  noAsks: 'No open questions.',
  questionPending: 'The question text has not arrived yet — you can answer in your own words.',
  ownAnswer: 'Own answer',
  send: 'Answer',
  cancelReason: 'Cancelled from the phone',
  editInPanel: 'Editing the split is available in the panel only.',
  applied: 'The core accepted the answer.',
  noKey:
    'This phone has no signing key for this panel: bind the phone in "Decision signing" — the ' +
    'core accepts an answer only with a signature.',
  refused: (code: string) => `The core refused the answer${code ? `: ${code}` : ''}.`,
  permitBadge: 'Core question',
  permitHint: 'The answer goes to the core as a command signed with this phone’s key.',
  permitNoGrant:
    'The core did not name the repository or path of this question — there is nothing to build a grant from. Answer the question in the core task’s timeline.',
};
