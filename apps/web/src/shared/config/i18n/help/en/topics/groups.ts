import type { groupsRu } from '../../ru/topics/groups';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const groupsEn: typeof groupsRu = {
  topic: {
    title: 'Groups',
    summary: 'Core tasks and former groups: turning a Path into a core scenario',
    lead:
      'Task work is now run by the core: an estimate before launch, a scenario of steps, checks ' +
      'and publishing. The Groups page shows core tasks and former groups. Former groups are read ' +
      'only — their Path can be turned into a core scenario and launched with it.',

    guideTitle: 'What is inside',
    guideText:
      'First what changed. Then three frames of the page: core tasks with former runs, the grid ' +
      'of former groups and the “To core” dialog. At the end — what does not carry over into the ' +
      'core and where the data lives.',

    whatTitle: 'What changed',
    whatCaption: 'The former group runner is gone; the page stays, but the core runs the work.',
    whatCore: 'The core runs tasks',
    whatCoreText:
      'The top of the page lists core tasks: each shows its title, state and a link to its ' +
      'timeline. A new task starts right here: the launch form shows the estimate before the start. ' +
      'Groups of tasks are now built by the core: several items (tracker tickets, for example) ' +
      'with the “Several items” source and “As a group” become a task per item sharing one ' +
      'group, each run by the same lead as a single task. The group launch button launches all ' +
      'its tasks; one that did not launch is named with the reason, and a retry launches only ' +
      'it — that is also how a launch interrupted midway is finished. An XL goal becomes child ' +
      'tasks once the split is approved — see the “Core tasks” help, section “The lead”.',
    whatReadOnly: 'Former groups are read only',
    whatReadOnlyText:
      'Former groups can no longer be run, edited, switched on or created. A card shows the name, ' +
      'scope, the first three Path steps and a count of the rest.',
    whatImport: '“To core” is the only action',
    whatImportText:
      'A group with steps has one button on its card — “To core”. It turns the group Path into a ' +
      'core library scenario and opens launch with it.',
    whatRuns: 'Former runs stay visible',
    whatRunsText:
      'Group runs from before the switch stay listed with their state: “Finished” or ' +
      '“Cancelled”. The core does not continue them.',

    pageTitle: 'The page in frames',
    pageCaption:
      'The same section on a stand: one core task, two former groups and two former runs.',
    pageTasks: 'Core tasks and former runs',
    pageTasksText:
      '“New task” opens the launch form with an estimate. A task row shows the title, state and ' +
      '“Open the timeline”; a long title is cut with an ellipsis and the row never wraps. ' +
      'Below are former group runs: date, state and the plan groups with ' +
      'branch and status.',
    pageGrid: 'Former groups',
    pageGridText:
      'Tabs “Global” and “In projects”. A card shows the scope, “When” and the first steps. A ' +
      'group without steps gets no “To core” button: there is nothing to turn.',
    pageImport: 'The “To core” dialog',
    pageImportText:
      'The core turns the Path itself and lists the scenario steps in order; at the end the core ' +
      'adds its own “Final check” and “Publish”. A step the core cannot turn is named and saving is ' +
      'disabled: a scenario missing part of the Path is worse than a refusal. “Save and open ' +
      'launch” puts the scenario into the core library and opens the launch form with it.',

    carryTitle: 'What does not carry over',
    carryCaption: 'The core starts the task afresh — only the Path is taken from the former group.',
    carryBranch: 'Branch, copy and chat',
    carryBranchText:
      'The former group’s branch, working copy and chat do not move into the core task. The core ' +
      'task makes its own.',
    carryHalf: 'An unfinished run',
    carryHalfText:
      'A run in progress when the panel updated was cancelled once at start: its group statuses ' +
      'stay as they were, the pending questions of those groups are withdrawn. Questions from ' +
      'ordinary chats stay.',
    carryLanguage: 'Step language',
    carryLanguageText:
      'Every step title in the scenario — the group’s own and the ones the core adds — is in the ' +
      'panel language. A step without a title in that language takes the other one. The model ' +
      'reads the step text and the gate condition in English when a translation exists, otherwise ' +
      'in Russian.',
    carryMembers: 'Group members',
    carryMembersText:
      'The group’s rules, skills and hooks stay in their sections. A resource step goes into the ' +
      'scenario as a reference to knowledge of its kind.',

    storageTitle: 'Former groups and runs',
    storageGroups: 'Former groups',
    storageRuns: 'Former runs',
    storageScenarios: 'Core scenarios',
    storageScenariosValue: 'The core library — section “Core scenarios”',
  },

  shots: {
    page: {
      '01-core-tasks':
        'Core tasks: “New task”, the “Log triage” task row with its state and “Open the timeline”, ' +
        'below the former runs — “Cancelled” and “Finished” with their plan groups',
      '02-legacy-grid':
        'Former groups: tabs, a card with the first Path steps and the “To core” button, a card ' +
        'without steps — no button',
      '03-core-import':
        'The “To core” dialog: the scenario steps in order and the “Final check” and “Publish” ' +
        'steps the core adds',
    },
  },
};
