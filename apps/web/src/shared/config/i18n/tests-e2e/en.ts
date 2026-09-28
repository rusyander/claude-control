import type { testsE2eRu } from './ru.ts';

/** English texts of the e2e folder card; typed against the Russian module. */
export const testsE2eEn: typeof testsE2eRu = {
  title: 'Autotest folder',
  missing: 'The project has no e2e folder — agents have nowhere to put real tests.',
  found: 'Folder {{dir}} — the project’s own',
  created: 'Folder {{dir}} — created by the panel',
  specs_one: '{{count}} test file',
  specs_few: '{{count}} test files',
  specs_many: '{{count}} test files',
  specs_other: '{{count}} test files',
  hidden: 'hidden from git',
  notGit: 'project is not under git',
  framework: {
    playwright: 'Playwright',
    cypress: 'Cypress',
    pytest: 'pytest',
    unknown: 'framework not recognised',
  },
  candidates: 'Also matching:',
  choose: 'Use {{dir}}',
  chooseHint:
    'Make this folder the project’s autotest folder: sync, runs and watching follow it. The panel remembers the choice; the project is not changed.',
  missingHint:
    'The button creates e2e/ with a Playwright config and hides it from git — the project stays unchanged. Agents write the real tests there; the section matches them to cases.',
  create: 'Create folder',
  createHint:
    'Creates e2e/ with a Playwright config and hides it from git with a line in .git/info/exclude. “Remove folder” restores the project byte for byte.',
  sync: 'Update from folder',
  syncHint:
    'Parse the folder’s tests: new ones become cases, known ones get their code link refreshed. Case descriptions are never rewritten.',
  syncDone: 'Synced: {{files}} files, {{tests}} tests; {{added}} new cases, {{linked}} relinked.',
  syncMissing_one: '{{count}} case lost its test in the code.',
  syncMissing_few: '{{count}} cases lost their tests in the code.',
  syncMissing_many: '{{count}} cases lost their tests in the code.',
  syncMissing_other: '{{count}} cases lost their tests in the code.',
  syncSkipped:
    'Not turned into cases: {{count}} — the test name is built from variables at run time and cannot be read from the text.',
  remove: 'Remove folder',
  removeHint: 'Delete the panel-created folder and its .git/info/exclude line. Cases stay.',
  removeForeign_one:
    'The folder holds {{count}} file the panel did not write (an agent test or your edit). Remove it too?',
  removeForeign_few:
    'The folder holds {{count}} files the panel did not write (agent tests or your edits). Remove them too?',
  removeForeign_many:
    'The folder holds {{count}} files the panel did not write (agent tests or your edits). Remove them too?',
  removeForeign_other:
    'The folder holds {{count}} files the panel did not write (agent tests or your edits). Remove them too?',
  removeForce: 'Remove them too',
  cancel: 'Cancel',
  generateHint:
    'The agent proposes flow groups, writes specs into the e2e folder, runs them and saves the cases with results.',
  noStand:
    'No environment has a stand URL — the agent will write tests but has nothing to run them on. Set the URL in the environment settings.',
  onboard: {
    title: 'Autotest folder',
    created:
      'The project had no e2e folder — the panel created {{dir}} with a Playwright config and hid it from git. Agents write the tests there.',
    createdVisible:
      'The project had no e2e folder — the panel created {{dir}} with a Playwright config. The project is not under git, so there is nothing to hide it from.',
    synced:
      'Found folder {{dir}}: {{tests}} tests, {{added}} new cases — already in the Tests section.',
    foundEmpty: 'Found folder {{dir}} with no tests yet — cases appear once tests are written.',
    failed:
      'The project is added, but the e2e folder could not be created — use the button in the Tests section.',
  },
  run: {
    start: 'Run autotests',
    hint: 'The panel runs the folder’s tests itself with the framework’s command — no agent, no tokens. Results land on the cases and as one row in the run history.',
    stop: 'Stop',
    running: 'Autotests are running — the command and its output are below.',
    stopped: 'Stopped. Whatever reached the report has been applied.',
    stoppedNoReport: 'Stopped before the report — no results applied, run history untouched.',
    resultGreen: 'All passed: {{passed}} of {{total}}.',
    resultRed: '{{failed}} of {{total}} failed, {{passed}} passed.',
    resultSkipped: 'Skipped: {{count}}.',
    resultEmpty: 'The report holds no tests.',
    unmatched:
      'Without a case ({{count}}): {{names}} — “Update from folder” creates cases for them.',
    unmatchedMore: 'and {{count}} more',
    exitOdd:
      'The command exited with code {{code}} although no test failed — see the command output.',
    openRun: 'Open the run in history',
    command: 'Command',
    log: 'Command output',
    logEmpty: 'The command has printed nothing yet.',
    noFramework:
      'The folder’s framework is not recognised — the panel does not guess which command to run.',
    noSpecs: 'The folder has no test files — nothing to run.',
    agentBusy: 'An agent run is in progress and writes to the same files. Wait for it or stop it.',
    ownCommand: 'The project’s own command (.agent/tests/automation.json): {{command}}',
    group: 'Only “{{title}}”',
    groupHint: 'Run only the autotests of the cases in “{{title}}” — files: {{count}}.',
    groupEmpty:
      'The cases in “{{title}}” have no autotest (the automation.file field) — there is nothing to run.',
    error: {
      'e2e-run-no-report':
        'No report appeared — the command was not found or failed before the tests. See the command output.',
      'e2e-run-spawn': 'The command could not be started.',
      'e2e-run-import': 'The report exists but could not be parsed.',
      'e2e-run-not-installed':
        'The autotest runner is not installed, and the panel does not install it itself — it will not download hundreds of megabytes unasked. Run in {{dir}}: {{install}}',
    },
  },
};
