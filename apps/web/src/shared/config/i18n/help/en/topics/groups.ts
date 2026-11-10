import type { groupsRu } from '../../ru/topics/groups';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const groupsEn: typeof groupsRu = {
  topic: {
    title: 'Groups',
    summary: 'Core task groups are board lanes; a former Path carries over as a scenario',
    lead:
      'A group is no longer a page of its own: its tasks move along the core task board, one ' +
      'lane per group. The “Groups” menu entry opens that same board already in group lanes. ' +
      'Former group runs are read only, and the Path of a former group carries over as a core ' +
      'scenario.',

    guideTitle: 'What is inside',
    guideText:
      'First what changed. Then group lanes on the board in frames: the lanes, “Closed” with the ' +
      'former runs and “Import items”. At the end — what does not carry over into the core and ' +
      'where the data lives.',

    whatTitle: 'What changed',
    whatCaption:
      'The former group runner is gone and so is the groups page — groups live on the board.',
    whatCore: 'The core assembles a group',
    whatCoreText:
      'Several items (tracker issues, say) on the launch screen — source “Several items” and “As ' +
      'a group — a task per item”: a task per item under one shared group number, all run with ' +
      'the same lead as a single task. “To queue” puts the whole group on the board as one entry, ' +
      'and at start every task of the group carries that entry. The group launch button starts ' +
      'all its tasks; one that did not start is named with its reason, and a retry starts only ' +
      'it. An XL-class goal becomes child tasks once its split is approved — see the “Core tasks” ' +
      'help, section “The lead”.',
    whatLanes: 'Groups are board lanes',
    whatLanesText:
      'The /groups address and the “Groups” menu entry lead to the “Core tasks” board with the ' +
      '“By group” filter. The number next to the menu entry and the “Groups” tile on “Overview” ' +
      'count the open lanes.',
    whatReadOnly: 'Former runs are read only',
    whatReadOnlyText:
      'Group runs from before the switch sit under “Closed”: date, state and the plan’s groups ' +
      'with branch and status. The core does not continue them.',
    whatImport: '“Import items” — the way for a former group',
    whatImportText:
      'A former group cannot be run, changed or switched on. Its Path is turned into a core ' +
      'library scenario by the “Import items” button on the board, and launch opens with it.',

    lanesTitle: 'Groups on the board in frames',
    lanesCaption:
      'The board on a stubbed stand: two groups of two tasks each, one closed task, one former run ' +
      'and one former group with a Path.',
    lanesBoard: 'Lanes “By group”',
    lanesBoardText:
      'The “By group” filter above the board draws a lane per group: “Group 00a11a · tasks: 2” ' +
      'with the same columns as the whole board — from “Inbox” to “Waiting for you”. The “Group …” ' +
      'buttons beside it narrow the board to one group. A group task’s card carries the “group” ' +
      'mark. With no groups the board says how a group appears.',
    lanesClosed: '“Closed” and former runs',
    lanesClosedText:
      '“Show closed” unfolds the closed tasks and, under them, “Former group runs”: read only. An ' +
      'unfinished run is stopped for the core; its copy, branch and request do not move into core ' +
      'tasks.',
    lanesPick: '“Import items” — picking a group',
    lanesPickText:
      'A button in the board header. The “Import from a former group” dialog lists former groups ' +
      'with a Path and their step count; “Convert” hands the Path to the core. With no group that ' +
      'has a Path the dialog says so.',
    lanesSteps: 'Scenario steps and launch',
    lanesStepsText:
      'The core shows the scenario steps in order — the steps of the Path; checking and ' +
      'publishing are still done by the core. A step the core cannot convert without loss is ' +
      'named and saving is disabled: a scenario missing part of the Path is worse than a refusal. ' +
      '“Save and open launch” puts the scenario into the core library and opens the launch screen ' +
      'with it — then “To queue” or an estimate right away.',

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
    lanes: {
      '01-lanes':
        'The board “By group”: lanes “Group 00a11a” and “Group 00b22b” with two tasks each, the ' +
        'same columns, “Show closed (1)” below',
      '02-closed':
        '“Hide closed”: a closed task and “Former group runs” — read only, a finished run with its ' +
        'branch and status',
      '03-import-pick':
        'The “Import from a former group” dialog: group “Log triage”, 3 steps, the “Convert” button',
      '04-import-steps':
        'Group “Log triage” → core scenario: five steps in order, “Save and open launch”',
    },
  },
};
