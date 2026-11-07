import type { DecisionTexts } from './decisions.ru.ts';

const SIGNAL_OUTCOMES_EN = {
  quiet: 'Did not fire',
  show: 'Shown to the human',
  hint: 'Hint to the session',
  'stop-step': 'Step stopped',
  'pause-at-safe-point': 'Pause at a safe point',
};

/** English decision templates; the type is the same exhaustive class × outcome map. */
export const decisionsEn: DecisionTexts = {
  check: {
    label: 'Check',
    outcomes: {
      replay: 'Replay of a recorded result',
      run: 'Full run',
      narrow: 'Narrowed run',
      wait: 'Waiting in the queue',
      defer: 'Deferred',
      refuse: 'Refused',
      absent: 'Check not in the registry',
    },
  },
  compose: {
    label: 'Stand compose',
    outcomes: { ready: 'Stand ready', run: 'Stand starting', refuse: 'Stand not composed' },
  },
  window: {
    label: 'Limit window',
    outcomes: {
      open: 'Window open',
      warn: 'Window running low',
      refused: 'Window refused',
      held: 'Request held',
      exhausted: 'Limit exhausted',
      offline: 'Route offline',
    },
  },
  schedule: {
    label: 'Queue',
    outcomes: { granted: 'Slot granted', waiting: 'Waiting for a slot' },
  },
  requirements: {
    label: 'Requirements',
    outcomes: { covered: 'All requirements covered', uncovered: 'Some requirements uncovered' },
  },
  gates: {
    label: 'Gates',
    outcomes: { passed: 'Gates passed', closed: 'Gates closed' },
  },
  'publish-ready': {
    label: 'Publish readiness',
    outcomes: { allow: 'May publish', refuse: 'Publishing not allowed' },
  },
  'publish-text': {
    label: 'Publish text',
    outcomes: { pass: 'Text accepted', stripped: 'Extra text stripped', refused: 'Text refused' },
  },
  continuation: {
    label: 'Continuation',
    outcomes: { 'same-session': 'In the same session', fresh: 'In a fresh session' },
  },
  tier: {
    label: 'Model',
    outcomes: { picked: 'Model picked', refused: 'No model picked' },
  },
  'split-check': {
    label: 'Split',
    outcomes: { accepted: 'Split accepted', refused: 'Split refused' },
  },
  next: {
    label: 'Next action',
    outcomes: {
      'create-unit': 'Create a unit',
      'start-unit': 'Start the unit',
      'start-step': 'Start the step',
      'reenter-step': 'Re-enter the step',
      'run-step': 'Run the step',
      'run-core-step': 'The core runs the step',
      'post-step': 'Review the step result',
      remind: 'Remind the session',
      'derive-outcome': 'Derive the step outcome',
      'stop-step': 'Stop the step',
      'park-session': 'Park the session',
      'extend-budget': 'Extend the time',
      'extend-tokens': 'Add tokens',
      answered: 'Answer received',
      'close-human-step': 'Close the human step',
      'close-chat': 'Close the chat',
      'close-ask': 'Close the question: the answer arrived',
      raise: 'Ask the human',
      'skip-step': 'Skip the step',
      'end-unit': 'End the unit',
      'launch-children': 'Launch the next child tasks',
      'finish-task': 'Finish the task',
      'fail-task': 'The task failed',
      'cancel-task': 'Cancel the task',
      wait: 'Wait',
    },
  },
  'human-point': {
    label: 'Question to the human',
    outcomes: {
      blocking: 'Needs an answer, the step waits',
      'non-blocking': 'Question without a stop',
      fork: 'Fork decided by default',
      refused: 'Question not raised',
    },
  },
  authority: {
    label: 'Authority',
    outcomes: { allow: 'Command accepted', refuse: 'Command refused' },
  },
  permit: {
    label: 'Permission',
    outcomes: { allow: 'Action allowed', deny: 'Action denied' },
  },
  ownership: {
    label: 'Path ownership',
    outcomes: { inside: 'Inside owned paths', outside: 'Outside owned paths' },
  },
  safepoint: {
    label: 'Safe point',
    outcomes: { safe: 'Point is safe', unsafe: 'Point is unsafe' },
  },
  reconcile: {
    label: 'Action reconcile',
    outcomes: {
      happened: 'The action happened',
      'not-happened': 'The action did not happen',
      retry: 'Retry the action',
      ask: 'Ask the human',
    },
  },
  observer: { label: 'Observer', outcomes: SIGNAL_OUTCOMES_EN },
  'forged-publish': { label: 'Forged publish', outcomes: SIGNAL_OUTCOMES_EN },
  'hook-block': { label: 'Hook block', outcomes: SIGNAL_OUTCOMES_EN },
  'hook-loop': { label: 'Hook loop', outcomes: SIGNAL_OUTCOMES_EN },
  'copy-setup': {
    label: 'Working copy',
    outcomes: {
      ready: 'Copy ready',
      'ready-with-gaps': 'Copy ready with gaps',
      failed: 'Copy not prepared',
    },
  },
  'red-before': {
    label: 'Red before the fix',
    outcomes: { proven: 'Proven', unproven: 'Not proven', unknown: 'Could not check' },
  },
  cleanup: {
    label: 'Cleanup',
    outcomes: { release: 'Resources released', keep: 'Resources kept' },
  },
  compat: {
    label: 'Route compatibility',
    outcomes: { direct: 'Direct', 'via-gateway': 'Via the gateway', refused: 'Incompatible' },
  },
  fit: {
    label: 'Model fit',
    outcomes: { fits: 'Fits', short: 'Not enough memory' },
  },
  'slot-wait': {
    label: 'Slot wait',
    outcomes: {
      hold: 'Hold the slot',
      retry: 'Retry',
      release: 'Release the slot',
      foreign: 'Slot held by someone else',
      adopt: 'Adopt the slot',
      'human-point': 'Ask the human',
    },
  },
  endpoint: {
    label: 'Endpoint',
    outcomes: { serve: 'Served', refuse: 'Refused' },
  },
  budget: {
    label: 'Budget',
    outcomes: { within: 'Within', over: 'Over' },
  },
  'keep-warm': {
    label: 'Cache warm-up',
    outcomes: { ping: 'Warmed', skip: 'Skipped' },
  },
  'set-route': {
    label: 'Route change',
    outcomes: { applied: 'Applied', refused: 'Refused' },
  },
  precedence: {
    label: 'Settings levels',
    outcomes: {
      'within-levels': 'Everything within its level',
      'widening-rejected': 'Widening rejected',
    },
  },
  'layer-run': {
    label: 'User layer',
    outcomes: { 'as-asked': 'As asked', lowered: 'Lowered' },
  },
  intake: {
    label: 'Task intake',
    outcomes: { auto: 'Card accepted without a question', ask: 'Card awaits confirmation' },
  },
  classify: {
    label: 'Task class',
    outcomes: {
      S: 'Class S — a single edit',
      M: 'Class M — one unit and review',
      L: 'Class L — several units and integration',
      XL: 'Class XL — child tasks',
    },
  },
};
