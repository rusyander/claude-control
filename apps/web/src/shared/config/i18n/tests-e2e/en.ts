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
    resultNoCases: 'Tests in the report: {{count}} — none has a case yet.',
    resultAdoptedAfter:
      'Tests in the report: {{count}} — their cases were created after this run, its results did not land on them.',
    buildFailed_one:
      '{{count}} package did not build — the compiler error is in the command output.',
    buildFailed_few:
      '{{count}} packages did not build — the compiler errors are in the command output.',
    buildFailed_many:
      '{{count}} packages did not build — the compiler errors are in the command output.',
    buildFailed_other:
      '{{count}} packages did not build — the compiler errors are in the command output.',
    unmatched:
      'Without a case ({{count}}): {{names}} — “Update from folder” creates cases for them.',
    unmatchedMore: 'and {{count}} more',
    unmatchedAdopt: 'Without a case ({{count}}): {{names}}.',
    adopt_one: 'Create a case ({{count}})',
    adopt_few: 'Create cases ({{count}})',
    adopt_many: 'Create cases ({{count}})',
    adopt_other: 'Create cases ({{count}})',
    adoptHint:
      'Each test without a case gets a case linked to it: grouped by the test’s file, the file found in the project. Statuses arrive with the next run; add steps and a description later.',
    adopted_one: '{{count}} case created, groups: {{groups}}. The next run lands on it.',
    adopted_few: '{{count}} cases created, groups: {{groups}}. The next run lands on them.',
    adopted_many: '{{count}} cases created, groups: {{groups}}. The next run lands on them.',
    adopted_other: '{{count}} cases created, groups: {{groups}}. The next run lands on them.',
    adoptedNone: 'No new cases — these tests already have them.',
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
  automation: {
    title: 'Run command',
    intro:
      'Tests outside the e2e folder — go test, pytest, Gradle, Maven, cargo test — run through one project command. Results land on cases just like the folder’s autotests.',
    searching: 'Looking for tests in the project…',
    recipesTitle: 'Tests found — take a ready command:',
    noRecipes:
      'No ready command found from the project’s files (go.mod, pyproject.toml, build.gradle, pom.xml, Cargo.toml) — set your own.',
    custom: 'Set your own command',
    recipe: '{{stack}} · {{dir}}',
    root: 'project root',
    allModules: 'every module of the project ({{count}})',
    stack: {
      go: 'Go',
      pytest: 'pytest',
      gradle: 'Gradle',
      maven: 'Maven',
      cargo: 'Cargo',
    },
    evidence: 'found by {{files}}',
    tests_one: '{{count}} test file',
    tests_few: '{{count}} test files',
    tests_many: '{{count}} test files',
    tests_other: '{{count}} test files',
    wholeSuite: 'runs the whole suite — “Only group” does not narrow it',
    missing: '“{{tool}}” is not on this machine — the command will not start.',
    install: 'Install: {{install}}',
    take: 'Take',
    takeHint: 'Put the command into the fields — it is written on “Save”.',
    format: {
      junit: 'JUnit XML report',
      'go-test-json': 'go test -json output — the panel converts it to JUnit',
      'cargo-test': 'cargo test output — the panel converts it to JUnit',
    },
    reportFile: 'report — {{report}}',
    reportDir: 'reports — the {{report}} folder, this run’s *.xml are taken',
    timeout_one: 'limit {{count}} minute',
    timeout_few: 'limit {{count}} minutes',
    timeout_many: 'limit {{count}} minutes',
    timeout_other: 'limit {{count}} minutes',
    edit: 'Edit',
    remove: 'Remove command',
    removeHint:
      '.agent/tests/automation.json is set aside as automation.removed.json — not deleted.',
    fields: {
      command: 'Command',
      commandHint:
        '{files} — files of the selected cases (of every automated case when none is selected), {paths} — the selected files, empty when none is selected, {packages} — their Go packages, ./... when none is selected, {report} — the report path the panel assigns. Without placeholders the command runs the whole suite.',
      report: 'Report path',
      reportHint:
        'From the project root — if the command writes the report itself. Ending in / means a folder (Gradle, Maven). Empty — the panel’s path, given by {report}.',
      format: 'Report kind',
      timeout: 'Limit, minutes',
      timeoutHint: 'Longer — the run stops. Empty — no limit.',
    },
    save: 'Save',
    cancel: 'Cancel',
    saved: 'The command is written to .agent/tests/automation.json.',
    removed: 'The command is removed — the file is set aside as automation.removed.json.',
    locked: 'An autotest run is in progress — change the command after it ends.',
    broken: 'The command file cannot be read: {{reason}}',
  },
  mutation: {
    title: 'Mutation check of the case set',
    hint: 'Will the cases catch a regression: in a separate copy of the repository the file is broken, the automated cases linked to it are run, and you see which went red. Your working copy, library and history do not change.',
    file: 'File',
    mode: 'Breakage',
    modeBreak: 'Coarse — the module fails on load',
    modeSubtle: 'Subtle — flip the first comparison',
    noCandidates: 'Nothing to break: no automated case has codePaths pointing at a project file.',
    start: 'Break and run',
    confirmTitle: 'Start the mutation check?',
    confirmText:
      'The panel will create a copy of the repository, break “{{file}}” and run the autotests linked to it. That takes minutes or more, like a full run of those tests.',
    confirm: 'Start',
    stop: 'Stop',
    stage: {
      copy: 'Creating a copy of the repository…',
      break: 'Breaking the file…',
      run: 'Autotests are running in the copy…',
      report: 'Reading the report…',
      cleanup: 'Removing the copy…',
    },
    mutation: 'Broken: {{what}}',
    kind: {
      'module-throws': 'the module throws on load',
      'module-raises': 'the module raises on import',
      'file-emptied': 'the file is emptied',
      'line-flip': 'line {{line}}: {{from}} → {{to}}',
    },
    caught: 'The breakage was caught by {{caught}} of {{count}} cases.',
    unprotected: 'The file is not protected by cases: none of the {{count}} went red.',
    noResult:
      'No result: the run report said nothing about any of the {{count}} cases — whether the file is protected is unknown. See the command output.',
    cleanupFailed:
      'The repository copy could not be removed ({{reason}}) — a process that outlived the run holds it. It will be removed on the next panel start.',
    stopped: 'The check was stopped.',
    caseCaught: 'caught it',
    caseMissed: 'missed it',
    caseNoResult: 'no result',
    log: 'Command output',
  },
};
