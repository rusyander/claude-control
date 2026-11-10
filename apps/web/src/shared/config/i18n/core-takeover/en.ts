import type { coreTakeoverRu } from './ru.ts';

/** A human takes over a unit, hands it back, asks for rework and sets the stop point. Typed against the Russian module. */
export const coreTakeoverEn: typeof coreTakeoverRu = {
  title: 'Take over',
  heading: 'Manual intervention',
  takeOver: 'Take over',
  takeOverHint:
    'The core pauses at the nearest safe point and frees the slot. You work in the task copy — by hand or in a chat allowed to edit only that copy.',
  open: 'Takeover is open: you are driving the task.',
  copy: 'Copy',
  openChat: 'Open chat',
  note: 'What was done (goes to the next step)',
  handBack: 'Hand back to the core',
  handBackHint: 'The takeover chat closes first, then the core resumes the interrupted step.',
  rework: 'Send for rework',
  reworkText: 'What to rework',
  reworkHintRunning: 'The current step receives the message at the next turn boundary.',
  reworkHintDone: 'A review-answer task opens on the open MR with this text.',
  stop: 'Where to stop',
  stopHint: 'The stop point cannot change after the MR.',
  stops: {
    plan: 'At the plan',
    mr: 'At the MR',
    end: 'To the end',
  },
  sending: 'Sending…',
  applied: {
    'take-over': 'Takeover opened.',
    'hand-back': 'Task handed back to the core.',
    rework: 'Rework sent.',
    'set-stop': 'Stop point saved.',
  },
  refused: 'The core refused: {{reason}}',
  failed: 'Not sent: {{reason}}',
};
