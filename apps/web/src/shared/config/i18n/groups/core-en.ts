import type { groupsCoreRu } from './core-ru.ts';

/** English texts of the Groups page over the core (stage 10, F1); typed against the Russian module. */
export const groupsCoreEn: typeof groupsCoreRu = {
  heading: 'Core tasks',
  hint: 'Group work now runs as core tasks: an estimate before launch, a scenario of steps, checks and publishing by the core. The former groups below are here to turn their Path into a core scenario.',
  launch: 'New task',
  hideLaunch: 'Hide launch',
  empty: 'The core has no tasks yet — start with “New task” or convert a group with “To core”.',
  loadError: 'Could not read the core task list',
  refusal: {
    'core-absent': 'The core is not running — tasks and launch are unavailable until it is.',
    'core-unverified':
      'The core did not verify itself — the panel does not forward requests to it.',
    'core-unreachable': 'The core does not answer — tasks and launch are unavailable.',
  },
  legacyHeading: 'Former groups',
  legacyHint:
    'Groups of the former path. The core does not run them: “To core” turns the group Path into a core library scenario and opens launch with it.',
  tileImport: 'To core',
  tileImportAria: 'Turn the Path of group {{name}} into a core scenario',
  import: {
    title: 'Group “{{name}}” → core scenario',
    intro:
      'The scenario steps are the group Path steps in order; checks and publishing are still done by the core. Saving puts the scenario into the core library, then launch opens with it.',
    reading: 'The core is converting the Path…',
    failed: 'The core did not convert the Path',
    problems: 'The core cannot convert this group without losing something:',
    steps: 'Scenario steps',
    save: 'Save and open launch',
    cancel: 'Cancel',
    saveFailed: 'The scenario was not saved: {{reason}}',
  },
  runs: {
    heading: 'Former group runs',
    hint: 'Read only. The core does not adopt former runs: an unfinished run is stopped for the core, its copy, branch and request do not move into core tasks.',
    state: {
      finished: 'Finished',
      cancelled: 'Cancelled',
      'half-run': 'Unfinished — the core does not adopt it',
    },
    group: '{{title}} · {{branch}} · {{status}}',
    status: {
      pending: 'queued',
      waiting: 'waits for another group',
      held: 'held on a question',
      started: 'was running',
      awaiting: 'was awaiting an answer',
      background: 'was running in background',
      paused: 'paused',
      done: 'done',
      failed: 'failed',
    },
    loadError: 'Could not read former runs',
  },
};
