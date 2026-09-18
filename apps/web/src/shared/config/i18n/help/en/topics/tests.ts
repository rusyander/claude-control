import type { testsRu } from '../../ru/topics/tests';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const testsEn: typeof testsRu = {
  topic: {
    title: 'Tests',
    summary: 'A tester workspace: the case library, plans, runs and the project report',
    lead:
      'The section keeps the test cases of the selected project: what they check, how they ' +
      'check it and how the last run ended. The cases live not in the panel but in the ' +
      'project itself — in its .agent/tests directory, as plain files — so they travel with ' +
      'the code and are visible to anyone who opens the repository without the panel. Here ' +
      'the panel is an editor, a remote and a report; the storage is the repository.',

    guideTitle: 'How to read this page',
    guideText:
      'Two diagrams first: where the suite lives and what turns the milestone verdict ' +
      'red. Then the whole path in screenshots — “the first suite” is done once, “a ' +
      'suite that already lives” is what comes afterwards and repeats. After the ' +
      'screenshots come the field and state tables, and at the end the refusals and how ' +
      'to undo anything.',

    whyFiles: 'Cases live in the project',
    whyFilesText:
      'The .agent/tests files sit next to the code they check. A branch with a new feature ' +
      'carries the cases for it, reverting the code reverts the cases, and the edit history ' +
      'of a case is plain git history.',
    whyBoth: 'Both sides write',
    whyBothText:
      'The same file is edited by a human through the panel forms and by the agent by hand ' +
      'during a run. Hence every rule of the format: someone else’s write must lose nothing, ' +
      'and broken JSON must not black out the whole list.',
    whyOne: 'One place instead of three',
    whyOneText:
      'Library, run, history and report are all here. A separate TMS next to the repository ' +
      'would be a third system to synchronise by hand, and the first diverged version of a ' +
      'case devalues both.',

    vsTitle: 'What this is not',
    vsCaption:
      'The section has four neighbours and is confused with each of them differently. ' +
      'Until it is said what it is not, half the questions about it are about things it ' +
      'never did.',
    vsTms: 'Not a TMS',
    vsTmsText:
      'No database of its own, no users or roles, no run schedule. Everything the ' +
      'section knows is files inside the project under test, and the rights to them are ' +
      'the rights to the repository. Cases can be imported from a TMS as a table, but ' +
      'nothing syncs back.',
    vsChat: 'Not the chat',
    vsChatText:
      'The agent starts through the same CLI as in the chat, but there is no ' +
      'conversation: a run has no feed, no questions to the human and no permission ' +
      'prompts — during a run the agent may touch only test files. The other way round ' +
      'too: cases are not kept from the chat, which the console says out loud.',
    vsCi: 'Not CI',
    vsCiText:
      'The panel runs nothing on a schedule and guards no branch. Build results arrive ' +
      'here by import, as a separate record signed as someone else’s run, and what ' +
      'turns a gate red is pnpm tests report in your pipeline, not the panel.',
    vsProjects: 'Not the Projects section',
    vsProjectsText:
      'Projects registers a repository, its branches and parallel copies. Here there is ' +
      'only the test suite of the selected project: the section takes the path and the ' +
      'current branch from the registry and then lives in .agent/tests.',

    guide: {
      mapTitle: 'What actually happens here',
      mapCaption:
        'Two diagrams answer what the screenshots cannot: where everything is written, ' +
        'and why a red case does not always colour the verdict.',
      mapTextTitle: 'The same in words',
      mapTextText:
        'Three parties write into the suite: a human through a manual run, a CLI agent ' +
        'through a run, CI through an imported report. All three write, via the panel, ' +
        'into the project’s files: the group’s cases with their last status, the run ' +
        'record and the failure evidence. From there they travel into a commit with the ' +
        'code. After that one flag decides: a failure without quarantine goes into the ' +
        'milestone verdict and reddens the gate; a failure in quarantine stays visible ' +
        'and real but out of the verdict, and in the junit export it leaves as skipped ' +
        'with its reason.',

      startTitle: 'The first suite: from an empty section to a report',
      startCaption:
        'Ten steps done once per project. After that the suite is only run — that is ' +
        'the second walkthrough.',
      wEmpty: 'Step 1. The empty section',
      wEmptyText:
        'The project is selected, there are no cases yet — and the panel shows not an ' +
        'empty table but three steps: environment, generation, first run. The line under ' +
        'the project picker says where the files will go: “Cases: .agent/tests”. The ' +
        'console on top is already complete: Run, Full retest, Changed only, Explore, ' +
        'Automate.',
      wEnvironment: 'Step 2. The environment',
      wEnvironmentText:
        'An environment is the stand address and the credentials for it; without one a ' +
        'run is blind. Once created, it closes the first step with a tick and signs it: ' +
        '“Done: Local. Passwords for it are behind the Access button.” The passwords ' +
        'themselves never reach a case, an agent prompt or a report.',
      wGroup: 'Step 3. The group',
      wGroupText:
        'A group is a file. The identifier in the field (“smoke”) becomes the name ' +
        'smoke.tests.json in .agent/tests: latin letters, digits, hyphen. Everything in ' +
        'the group travels as one file with one history.',
      wCase: 'Step 4. The case',
      wCaseText:
        'The form asks for more than steps. “Why” is what the steps cannot imply: “The ' +
        'cart is the entrance to payment: nothing further can be checked without it.” ' +
        '“Oracle” is what the verdict is read from: “The header counter and the item row ' +
        'in the cart.” The section is a slash path — “Cart/Adding” — and the tree on the ' +
        'left is built from it.',
      wLibrary: 'Step 5. The library',
      wLibraryText:
        'Six cases in the SMOKE group: the section tree on the left (Cart 3, Checkout 2, ' +
        'Catalogue 1), filters on top by status, priority, type, readiness, automation, ' +
        'area, tag and quarantine. The counter above the list reads at a glance: “0 ' +
        'passed · 0 failed · 0 skipped · 6 not run”.',
      wRunner: 'Step 6. The manual run',
      wRunnerText:
        'The “Run manually” button opens a pass over the suite: the header says “Case 1 ' +
        'of 6 · closed 0” and runs a timer. The outcome is marked per step — passed, ' +
        'failed, skipped, blocked — and the digit on a button works as a key. Inside ' +
        'input fields the keys are deliberately inert.',
      wFailed: 'Step 7. The failure',
      wFailedText:
        'The second case is red: the step “Press the plus in the item row” is marked, ' +
        'the step note says “The quantity stayed 1, the sum was not recalculated”, and ' +
        '“What happened” says “The plus button does not increase the quantity: the order ' +
        'sum stays the same.” That note goes into the defect if the pass failed, and it ' +
        'is what groups “identical failures”. Next to it: attach a file, file a defect.',
      wAfter: 'Step 8. The library after the pass',
      wAfterText:
        'The same list with real statuses: “5 passed · 1 failed · 0 skipped · 0 not ' +
        'run”. The status lives in the case file, not in the run record, so it is ' +
        'visible to anyone opening the repository without the panel.',
      wRecord: 'Step 9. The run record',
      wRecordText:
        'The Runs tab: “manually”, “human”, the date, branch main, environment local, ' +
        '“passed: 5 failed: 1 skipped: 0 duration: 15 s”. The red case is marked ' +
        'separately — “no evidence” — with “Rerun the failed (1)” and “Compare with the ' +
        'previous” beside it.',
      wReport: 'Step 10. The report',
      wReportText:
        'The Report tab sums the suite up: case states, automation coverage (“autotest: ' +
        '0, to automate: 0, manual: 6”) and the totals (“Runs: 1”, the last run with its ' +
        'date). There is nothing to compare with yet, and the panel says so: “this is ' +
        'the first run with results”.',

      liveTitle: 'A suite that already lives',
      liveCaption:
        'The second path: eight steps done afterwards and repeatedly — what the edits ' +
        'touched, quarantine, the milestone verdict, requirement coverage and the CI ' +
        'exchange.',
      hChanged: 'Step 1. Run only what the edits touched',
      hChangedText:
        '“Changed only” looks at what the working tree changed and matches the paths ' +
        'against the cases’ code links. Here the tree is clean — and the panel says so ' +
        'plainly: “The working tree edits matched no case.” An empty list means “nothing ' +
        'to attribute”, never “run everything”: a case with no code links can never land ' +
        'here.',
      hQuarantine: 'Step 2. Put a case in quarantine',
      hQuarantineText:
        'The case is ticked (“Selected: 1”), the action is “quarantine”, and the panel ' +
        'asks for a reason: “Waiting for the sum recalculation fix, defect SHOP-31 is ' +
        'open.” The caption under the field explains why: without a reason nobody will ' +
        'ever take the case back out.',
      hMuted: 'Step 3. What quarantine changes in the list',
      hMutedText:
        'Nothing but one line. The case is still “failed”, still in the list and still ' +
        'runs, and the reason shows right in the row: “quarantine: Waiting for the sum ' +
        'recalculation fix, defect SHOP-31 is open.” Quarantine removes exactly one ' +
        'right — colouring the verdict and the gate.',
      hRelease: 'Step 4. The milestone verdict',
      hReleaseText:
        'The same suite and the same red case — but the verdict is now “Ready to ship”: ' +
        '“Milestone v1.4: 5 of 6 passed, nothing the panel checks stands in the way. 1 ' +
        'in quarantine — their failures do not count.” The failure is not hidden: it ' +
        'stands on its own line, “Failures in quarantine: 1”, with its reason.',
      hHealth: 'Step 5. What the failures are proven by',
      hHealthText:
        'Further down the same tab: three counters — “red cases: 1”, “with evidence: 0”, ' +
        '“with a step breakdown: 1” — and a “Re-run the unproven” button. Next to them ' +
        'the suite linter (“Cases checked: 6”, 5 no-oracle notices and 1 ' +
        'no-code-paths) and the quarantine thresholds: 5 green runs in a row suggest ' +
        'lifting it, stability below 70% suggests setting it, and the panel applies ' +
        'nothing itself.',
      hCoverage: 'Step 6. Requirement coverage',
      hCoverageText:
        'The Coverage tab turns the suite the other way round: not “what we check” but ' +
        '“what is left unchecked”. Here two requirements come from case links (SHOP-14 ' +
        'and SHOP-21, two cases each) and “Cases with no requirement: 2”. The honest ' +
        'caveat sits below: without Atlassian only requirements from case links are ' +
        'shown — a JQL query would add the issues nobody linked.',
      hExchange: 'Step 7. Importing CI results',
      hExchangeText:
        'The import dialog takes a build report: format “JUnit XML”, file in project ' +
        '“test-results/junit.xml”. The outcome shows at once: “read: 3, matched cases: ' +
        '2, not found: 1 — Nobody’s autotest”. A test that matched nothing spoils ' +
        'nothing and reddens nobody: it is simply named.',
      hImported: 'Step 8. Someone else’s run in the history',
      hImportedText:
        'The import landed as statuses on the cases and as its own record in the ' +
        'history — “import”, “CI”, branch main, “passed: 2”. The manual run stays where ' +
        'it was under its own signature: “manually”, “human”, “local”. Who ran it is ' +
        'part of the record, not a guess from the timestamp.',

      priceTitle: 'What quarantine costs',
      priceText:
        'Quarantine is neither a fix nor an archive. The case stays red and keeps ' +
        'running, but stops colouring the milestone verdict and the CI gate: pnpm tests ' +
        'report does not count it as a failure, and the junit export carries it as ' +
        'skipped with its reason. Until the reason is cleared, the suite stays silent ' +
        'about a real breakage — which is why the reason is demanded as text.',
      shotsTitle: 'About the screenshots',
      shotsText:
        'Every shot was taken on a separate stand with a made-up project: six cases, ' +
        'one milestone, one defect. None of your projects and none of your real ' +
        'credentials appear in them. The numbers in the captions come from those same ' +
        'frames.',
    },

    storageCaption:
      'Everything inside the project under test. The panel keeps no database of its own: ' +
      'these files are the single source of truth.',
    storageGroup: 'Case group',
    storageShared: 'Shared steps',
    storageEnvironments: 'Environments',
    storageSchema: 'Custom fields and statuses',
    storageViews: 'Saved filters',
    storagePlans: 'Test plans',
    storageRuns: 'Run history',
    storageAttachments: 'Evidence attachments',
    storageVersions: 'Versions and review',
    storageVersionsValue:
      'come from the project git — there is deliberately no versioning mechanism of its own',

    libraryTitle: 'The library',
    libraryCaption:
      'What the set of checks is built from. The words are the familiar ones: groups, ' +
      'sections, cases, checklists, shared steps, parameters, attributes, tags.',
    libraryGroups: 'Groups = files = tabs',
    libraryGroupsText:
      'The file gui.tests.json is the "GUI" tab. Add a file — a tab appears. Groups split ' +
      'the set coarsely: interface, end-to-end scenarios, smoke.',
    librarySections: 'Sections — a tree inside a group',
    librarySectionsText:
      'The section field holds a path like "Chat/Attachments", and the panel draws a tree ' +
      'from it. Sections are not files: a case moves between them with a bulk action, ' +
      'touching nothing on disk.',
    libraryCase: 'A case — a detailed scenario',
    libraryCaseText:
      'A precondition, steps where each one has its own expectation and its own data, an ' +
      'overall expected result, a postcondition and an oracle — what exactly proves that it ' +
      'passed.',
    libraryChecklist: 'A checklist — a short check',
    libraryChecklistText:
      'The same item with type checklist: a list of points without expectations or ' +
      'preconditions. For smoke sets where writing the steps down costs more than walking ' +
      'them.',
    librarySharedSteps: 'Shared steps',
    librarySharedStepsText:
      'A fragment repeated in a dozen cases ("log in as the test user") is written once in ' +
      '_shared.steps.json. A case references it and the reference expands during a run — ' +
      'editing the shared step changes every case at once.',
    libraryParameters: 'Parameters',
    libraryParametersText:
      'A case with parameters (%login, %browser) is not one pass but as many as there are ' +
      'value combinations. The panel expands them into test points: full combinatorics, or ' +
      'pairwise when the full one grows indecent.',
    libraryAttributes: 'The project’s own fields',
    libraryAttributesText:
      'schema.json describes fields the common format has no room for: "module", "release", ' +
      '"requirement number". They become a column in the list and a field in the case form. ' +
      'Custom statuses on top of the canonical five live there too.',
    libraryTags: 'Tags and saved filters',
    libraryTagsText:
      'A tag is the cheapest way to assemble a set ("regression", "smoke", "payments"). A ' +
      'tuned filter is saved as a view (views.json) and then works as a dynamic set: its ' +
      'cases are recomputed at the moment of the run.',

    setupTitle: 'Suite settings',
    setupCaption:
      'Environments, shared steps and custom fields are created from the screen — the "Suite ' +
      'settings" button next to the project picker. It writes the same three files the whole ' +
      'section reads.',
    setupEnv: 'Environments',
    setupEnvText:
      'Address, browser, OS and the command that brings the stand up. The one marked default ' +
      'is preselected in the run bar and in plans; an archived one disappears from the picker ' +
      'but stays in run history — a past report must not lose where it was run.',
    setupSteps: 'Shared steps',
    setupStepsText:
      'Steps are typed line by line, the way they are written. Next to each one is how many ' +
      'cases use it: that is the only thing worth knowing before editing or deleting it, and ' +
      'it is counted by references in cases, not by matching titles.',
    setupFields: 'Custom fields',
    setupFieldsText:
      'A field key travels into every case, so it is checked before sending: latin letters, ' +
      'digits and a hyphen. A saved field becomes a column in the list and a field in the case ' +
      'form at once. Project statuses in schema.json are left alone — those are edited in the file.',
    setupSecrets: 'Stand credentials',
    setupSecretsText:
      'The "Credentials" button on an environment opens the same window as before a run: there ' +
      'is no second place to type them, or the password lives in two forms and drifts apart.',
    setupRemoveTitle: 'Deleting an environment names the plans',
    setupRemoveText:
      'If a plan references the environment, the panel stops the deletion and lists those plans ' +
      'by name: an environment removed silently turns a plan into "run it who knows where", and ' +
      'that surfaces only during the run itself. Its credentials are erased along with it.',
    setupBrokenTitle: 'A broken file only breaks itself',
    setupBrokenText:
      'If environments.json, _shared.steps.json or schema.json fails to parse, the window shows ' +
      'the file name and the reason at the top, and the panel does NOT write to it: saving over ' +
      'it would rewrite the whole file and erase what was written by hand. Fix it — the edit waits.',

    fieldsTitle: 'Case fields',
    fieldsCaption:
      'The names are the real ones — exactly as they sit in the file, so the case can be ' +
      'found by eye in the repository.',
    fieldTitle: 'What is being checked — the only required field',
    fieldType: 'case or checklist: a detailed scenario or a short check',
    fieldPurpose: 'Why the case exists — what the steps cannot tell you',
    fieldArea: 'The area of the app and the section path inside the group',
    fieldPrecondition: 'The state the check starts from',
    fieldSteps: 'A step: what to do, what should happen on it and what data to put in',
    fieldExpected: 'What should come out overall',
    fieldPostcondition: 'What to restore afterwards so the next case starts clean',
    fieldOracle: 'What proves the result: text on screen, a database row, a network answer',
    fieldPriority: 'blocker, high, medium, low — what you sort by when there is no time for all',
    fieldReadiness: 'Readiness of the description itself: draft, ready, obsolete',
    fieldDuration: 'Expected time to walk it through, in minutes',
    fieldTags: 'Tags: sets are assembled and the list is filtered by them',
    fieldLinks: 'Links to a requirement, an issue, an MR or a document',
    fieldParameters: 'Parameter names and values the passes are expanded from',
    fieldAutomation: 'manual, toAutomate, automated plus the file and the test name',
    fieldExternalId:
      'A stable marker of the test in the code itself (@TC-14, a junit property, an ' +
      'allure label). Checked before the name: a name does not survive every refactor, ' +
      'and after a rename the CI result silently went to “unmatched”',
    fieldMuted:
      'Quarantine: the failure is known and does not colour the run. A reason is ' +
      'mandatory — in a month nobody remembers it',
    fieldDefects: 'Issues filed for a failure: the address, the key and what the tracker last said',
    fieldCodePaths: 'Code files the case touches: the diff-based selection is computed from them',
    fieldStatus: 'The last result, what was actually seen and when that was',
    fieldSource: 'agent or human: the agent is forbidden to delete what a human wrote',

    statesTitle: 'Case states',
    statesCaption:
      'A case row carries status, readiness, automation and quarantine side by side — ' +
      'four independent flags, not one scale. A case can be failed, ready, manual and ' +
      'quarantined all at once.',
    stateColumn: 'Flag',
    stateMeaningColumn: 'What it means',
    stateNotRun: 'not run',
    stateNotRunText:
      'Status. There is no result at all: the case exists but no run has touched it. In ' +
      'a milestone summary these count as unchecked, not as green.',
    stateRunning: 'running',
    stateRunningText:
      'Status. A run is in progress and has reached this case. If the panel restarted ' +
      'mid-run, the status stays as it was until the current run closes — the truth is ' +
      'always in the file, not on the screen.',
    statePassed: 'passed',
    statePassedText: 'Status. The last run closed the case green.',
    stateFailed: 'failed',
    stateFailedText:
      'Status. The last run closed the case red. A failure goes into the milestone ' +
      'verdict and into the CI gate — except for quarantined cases.',
    stateSkipped: 'skipped',
    stateSkippedText:
      'Status. The executor deliberately did not check the case in this run. Neither ' +
      'green nor red: out of the verdict, but not counted as covered either.',
    stateBlocked: 'blocked',
    stateBlockedText:
      'Status. There was nothing to check with: the stand was down, the data missing, a ' +
      'neighbouring feature broken. Unlike a failure, it says nothing about the case ' +
      'itself.',
    stateDraft: 'draft',
    stateDraftText:
      'Readiness. The case is written but nobody vouches for its wording. Nothing stops ' +
      'it from running — the flag is for whoever reads the suite.',
    stateReady: 'ready',
    stateReadyText:
      'Readiness. The case has been reviewed and can be measured with: the default state of a suite that is kept.',
    stateStale: 'stale',
    stateStaleText:
      'Readiness. The case has diverged from the application and its result cannot be ' +
      'trusted whatever it is. Set by hand or on the panel’s suggestion — the panel ' +
      'never moves a case there itself.',
    stateManual: 'manual',
    stateManualText:
      'Automation. The case is walked by a human or an agent step by step; there is no autotest behind it.',
    stateToAutomate: 'to automate',
    stateToAutomateText:
      'Automation. The case is queued for an autotest. That is an intent, not a fact: ' +
      'until the autotest exists the case is still walked by hand.',
    stateAuto: 'autotest',
    stateAutoText:
      'Automation. An autotest is attached — file, name and the identifier by which a ' +
      'run result finds the case even after the file moved.',
    stateMuted: 'quarantine',
    stateMutedText:
      'A separate flag on top of the status. The case still runs and its status is ' +
      'real, but the right to colour the milestone verdict and the CI gate has been ' +
      'taken away. It is not set without a reason in words.',
    stateArchived: 'archived',
    stateArchivedText:
      'A separate flag. The case is out of the lists and out of runs, but not lost: it ' +
      'stays in the file, shows under the “Show archive” toggle and comes back in one ' +
      'action. Archived cases do not count towards requirement coverage at all.',

    plansTitle: 'Plans and environments',
    plansCaption:
      'A plan answers "what do we check this time", an environment answers "on what". ' +
      'Together they give a list of passes, not a list of cases.',
    plansStatic: 'A static plan',
    plansStaticText:
      'Cases listed by name. Right for release acceptance: the set must not change under ' +
      'your hands while the run is going.',
    plansDynamic: 'A dynamic plan',
    plansDynamicText:
      'A filter instead of a list: "everything tagged regression with priority at least ' +
      'high". Cases are picked at the moment of the start, so a new case joins the plan by ' +
      'itself.',
    plansEnvironments: 'Environments',
    plansEnvironmentsText:
      'A stand, a browser, an OS, the app address and the command that brings it up. A plan ' +
      'can be run on several — the results do not mix: every pass carries its environment.',
    plansPoints: 'Test points',
    plansPointsText:
      'Case × environment × parameter combination = one pass. It is the points that are ' +
      'walked by hand and counted in the summary: five cases on two browsers are ten ' +
      'results, not five.',
    plansLockedTitle: 'A locked plan',
    plansLockedText:
      'A plan can be locked against edits. This is not about access rights but about an ' +
      'honest report: a set that changed mid-acceptance makes its result unverifiable.',

    manualTitle: 'The manual runner',
    manualCaption:
      'A human does the checking, the panel records it. The result lands in the same file ' +
      'and the same history as an agent run — the report does not split them into "real" ' +
      'and "the rest".',
    manualStep1: 'Pick what to walk',
    manualStep1Text:
      'Tick the cases, choose a plan or just a group. If the plan has environments, choose ' +
      'one — it goes into the run record.',
    manualStep2: 'Start the run',
    manualStep2Text:
      'The panel expands the selection into test points and opens the first one. The session ' +
      'lives on the server: it can be continued in another tab or from the phone.',
    manualStep3: 'Walk the steps',
    manualStep3Text:
      'Every step has its own mark, the pass as a whole has a status: passed, failed, ' +
      'skipped, blocked. Blocked means "someone else’s breakage is in the way, the step ' +
      'cannot be reached", and that is not the same as a failure.',
    manualStep4: 'Write down what you saw',
    manualStep4Text:
      'A note and an evidence attachment (a screenshot, a piece of a log) are stored next to ' +
      'the result. A failure with no description of what was seen is half the work: there is ' +
      'nothing to fix from it.',
    manualStep5: 'Finish or drop',
    manualStep5Text:
      '"Finish" writes the run into the history, "drop" throws it away. The buttons differ ' +
      'on purpose: "I am done" and "I changed my mind" leave a different trace, and mixing ' +
      'them means lying to the report.',
    manualKeysTitle: 'Keys of a manual point',
    manualKeysText:
      'The digit on a button closes the point with that verdict: 1 passed, 2 failed, ' +
      '3 skipped, 4 blocked. 5 puts the cursor in the note, 6 opens the file picker, ' +
      'arrows move between points. Digits, not letters, because a letter depends on the ' +
      'keyboard layout. While the cursor is in a field the keys stay silent — a typed ' +
      '«1» stays a character in the text.',

    firstStepsTitle: 'First steps in an empty project',
    firstStepsCaption:
      'While the suite has no cases at all, the Library tab shows three steps instead ' +
      'of an empty list — in the order they are actually done.',
    firstStepsEnv: 'Environment',
    firstStepsEnvText:
      'Where to run. The button creates the first default environment; its passwords go ' +
      'separately — the credentials button on the run bar puts them into the panel’s ' +
      'encrypted store, never into a project file.',
    firstStepsGenerate: 'Generation',
    firstStepsGenerateText:
      'The agent reads the app and proposes cases as a draft. Nothing reaches the ' +
      'library until the draft is accepted — the acceptance banner appears above.',
    firstStepsRun: 'First run',
    firstStepsRunText:
      'Once cases exist the steps disappear: the run bar hands them to the agent, and ' +
      'the manual run opens the point walker with keys and a stopwatch.',

    manualPhoneTitle: 'The same thing from the phone',
    manualPhoneText:
      'The phone app opens the very same session: the result can be marked where the app is ' +
      'being looked at, not later from memory at the computer. What was started in the panel ' +
      'continues in the hand and back — the session is one.',

    agentTitle: 'Agent runs',
    agentCaption:
      'Four different assignments, not one "start" button. The agent works on this computer: ' +
      "it brings the app up where the code lives. Its route is the chat's route: an enabled " +
      'contour carries the run too — on its model and with the same layers switched off. The ' +
      'route is resolved on every start, so a cleared tick takes effect from the next run.',
    agentGenerate: 'Generate',
    agentGenerateText:
      'The agent looks around the app and proposes cases: it extends the similar ones and ' +
      'marks the stale ones. The "scope" field narrows the work to the part you need — ' +
      '"chat and analytics only". Nothing reaches the library on its own — you accept it.',
    agentRun: 'Run',
    agentRunText:
      'The agent walks the cases live and writes the result into the file after EVERY one. ' +
      'That is why the ticks trickle in as it goes and an interrupted run does not lose what ' +
      'was already checked. "Full retest" first resets the statuses: an old "passed" will not ' +
      'pass for a new one.',
    agentExplore: 'Explore',
    agentExploreText:
      'A free search by charter: the agent looks for what no case covers yet and writes ' +
      'cases for what it finds — failures with the "failed" status and reproduction steps. ' +
      'The button stays inactive while the wish field is empty: that field IS the charter, ' +
      'and a session without one turns into an hour of wandering around the application.',
    agentAutomate: 'Automate',
    agentAutomateText:
      'The agent turns stable cases into automated test code and fills in automation: the ' +
      'file, the test name and the key. The number on the button is how many cases of the ' +
      'selection are not in code yet; the ones marked automated are skipped. The test name ' +
      'starts with the case id — the panel matches CI results by it and by the key.',
    agentAccessTitle: 'Full access for the duration of a run',
    agentAccessText:
      'A run happens in the background with nobody to ask, so the agent works without ' +
      '"Allow" cards. The assignment holds the boundary: it may change only the files in ' +
      '.agent/tests, and a bug it finds is a test result, not a reason to fix code.',
    agentChangedTitle: 'Selection by the diff',
    agentChangedText:
      'A run can be narrowed to the cases touched by the uncommitted changes of the working ' +
      'tree: the panel matches changed files against the codePaths field and the case area. ' +
      'It is a cheap way to check only what was touched.',
    agentConventionTitle: 'Asking from the chat',
    agentConventionText:
      'The buttons of this section explain the format to the agent themselves. An ordinary ' +
      'conversation knows nothing about it: say "run the tests" in the chat and it will ' +
      'check and write nothing down. The "Write into the project CLAUDE.md" button appends a ' +
      'block with the format and the rules to the end of the file; it is read in EVERY ' +
      'conversation. Your text is left alone, and pressing again adds nothing.',

    sourceTitle: 'Where generation takes its material from',
    sourceCaption:
      '"Generate cases" answers the question "what is here at all". At work people ask ' +
      'something else, and that is not another run mode but another reading: the panel ' +
      'collects the material itself and puts it into the task.',
    sourceCode: 'From the project code',
    sourceCodeText:
      'The "Generate cases" button: the agent looks over the whole application — screens, ' +
      'routes, label dictionaries — and proposes cases for what is used every day.',
    sourceRequirement: 'From a requirement',
    sourceRequirementText:
      'The "Cover with cases" button on a coverage-matrix row. The panel reads the Jira ' +
      'issue in full, description included, and hands its text to the agent. The link to ' +
      'the requirement is stamped into the accepted cases by the panel itself — the row ' +
      'stops being uncovered right after acceptance, not when the model remembers about links.',
    sourceDiff: 'From the branch diff',
    sourceDiffText:
      'The "By diff" button in the run bar: the branch compared with main — the panel tries ' +
      'origin/main, origin/master, main and master in turn, and in a single-branch repository ' +
      'takes the working tree; an empty diff stops the run instead of sending the agent to ' +
      'guess. The task gets the PATHS and the summary, not the changes themselves — the whole ' +
      'patch would push the library out of the window the run exists for. A case with no ' +
      'codePaths of its own gets them from the diff.',
    sourceDefect: 'From a failure',
    sourceDefectText:
      'The "Regression case" button at a red result in the run history. The steps of the ' +
      "case, the runner's note and the attachments go into the task, and the new case links " +
      'to the defect. The original case is left alone: it describes the normal scenario.',
    sourceRefusedTitle: 'A source that did not come together does not start a run',
    sourceRefusedText:
      'Jira is not connected, the branch has no changes, the case behind the failure is ' +
      'gone — the panel answers with the reason and starts no agent. Generation "for ' +
      'requirement QA-42" that never saw QA-42 would write plausible cases about nothing, ' +
      'and there would be no way to tell them apart.',

    draftTitle: 'Accepting what generation proposes',
    draftCaption:
      'Generation does not edit the library itself: it brings a draft, and what to take out ' +
      'of it is your call. In a project without git this is the only way to see the ' +
      'proposals as a list.',
    draftFile: 'Where the proposals live',
    draftFileText:
      "A run's draft is the file .agent/tests/drafts/<run>.draft.json. New cases land in the " +
      'group chosen at launch even when the agent named another one — the panel moves them and ' +
      'assigns the ids itself; an edit of an existing case stays in its group. Until it is accepted ' +
      'the group files are untouched, and there is nothing to undo: the library is as it was. ' +
      'A run can propose missing cases too — they travel as the same draft, the agent never ' +
      'writes them into the group files.',
    draftPick: 'One by one, not all at once',
    draftPickText:
      'The "The agent proposed changes" banner opens the list: the title, why the case is ' +
      'needed and its steps. Tick the ones you want and accept those — the rest keep ' +
      'waiting, or go to the archive with "Reject".',
    draftSimilar: 'Look-alikes are named up front',
    draftSimilarText:
      'Every proposal carries a "looks like …" line with a match percentage. Without it the ' +
      'third generation in a row drops a third "Login with an empty password" into the set, ' +
      'and you only notice a month later.',
    draftUndo: 'Acceptance can be undone',
    draftUndoText:
      'Added cases are removed, edited ones are restored from the snapshot. A case you had ' +
      'time to edit by hand or to run stays as it is — such a case is named on its own line.',
    draftAuto: 'Accept straight away',
    draftAutoText:
      'The switch next to the generate button: proposals land in the library unreviewed, ' +
      'marked as a draft. The position is remembered per project, and it can be turned on ' +
      'from the acceptance window itself — after the first proposals have been eyeballed.',
    draftRightsTitle: 'The run never writes to the library',
    draftRightsText:
      'Generation is allowed into the drafts folder only: even if the agent decides to edit a ' +
      'group itself, the write is refused. The one way into the library is acceptance in the ' +
      'panel, so "accept straight away" widens no rights and the undo always works.',

    runsTitle: 'History and report',
    runsCaption:
      'The status of a case is the LAST result, not a history. The history lives separately, ' +
      'in runs/, and everything else is computed from it.',
    runsColumn: 'What it shows',
    runsSummary: 'Run summary',
    runsSummaryText:
      'How much passed, failed, was skipped and blocked, who ran it (agent, human, CI), on ' +
      'which branch and commit. A green run from a week ago on someone else’s branch is not ' +
      '"we are fine".',
    runsCoverage: 'Coverage by area',
    runsCoverageText:
      'How many cases each area has and how many of them are green, plus the automation ' +
      'slice: by hand, queued for automation, automated.',
    runsFlaky: 'Flaky cases',
    runsFlakyText:
      'A case whose result jumps from run to run is computed from the history: the share of ' +
      'runs without a change of result. A flaky case is worse than a red one — people stop ' +
      'believing it.',
    runsSpend: 'Time and spend',
    runsSpendText:
      'The duration of the runs and the tokens spent. Money here is an estimate at API ' +
      'prices, not a bill: a subscription does not charge them.',
    runsSession: 'Open a run as a conversation',
    runsSessionText:
      'An agent run has a CLI session, and it opens in the chat as an ordinary conversation: ' +
      'you can see what the agent did step by step and why it decided the case had failed.',

    evidenceTitle: 'A failure with no proof',
    evidenceCaption:
      '“Does not work” is an impression, not a result: there is nothing to fix by it, and a week ' +
      'later nobody remembers what was actually seen. A run must analyse a failure, not state it.',
    evidenceWhat: 'What a failure must carry',
    evidenceWhatText:
      'The number of the step where it diverged, what should have happened on THAT step, what ' +
      'actually happened, and an attachment as proof: a screenshot or a slice of the log in ' +
      '`.agent/tests/attachments/<case>/`.',
    evidenceRetry: 'A second attempt inside the same run',
    evidenceRetryText:
      'A failed case is walked a second time right away. Same outcome — the failure is confirmed. ' +
      'A different one — the case is marked unstable and both attempts are written down: a test ' +
      'that answers differently on the same code is fixed before the application is.',
    evidenceReport: 'The count in the report',
    evidenceReportText:
      'The “How the failures are proven” card counts the NEWEST failure of each case: proven by a ' +
      'screenshot a month ago and unproven today means unproven. The button next to it re-runs ' +
      'exactly the unproven ones.',
    evidenceDefect: 'The defect draft',
    evidenceDefectText:
      'The failed step number, the expectation of that very step, the fact and the attachments go ' +
      'into the draft on their own — nothing the run already wrote has to be retold by hand.',
    evidenceKeepTitle: 'An incomplete result is never thrown away',
    evidenceKeepText:
      'A failure with no proof is flagged but accepted: losing half an hour of a run over a ' +
      'formality costs more than showing an incomplete result and calling it incomplete.',

    diffTitle: 'What changed since the previous run',
    diffCaption:
      'The summary answers “how much is red now”. Only a comparison of two runs answers ' +
      '“what broke since yesterday” — and the rerun starts from that same list.',
    diffLists: 'Five lists, every case in exactly one',
    diffListsText:
      'Broke · fixed · red again · appeared in the set · gone from the set. The lists never ' +
      'overlap: a case landing in two at once would also be launched twice.',
    diffPrevious: 'Which run it is compared with',
    diffPreviousText:
      'With the closest run older than this one that has results: generation and imports live ' +
      'in the same history and there is nothing to compare with them. For the very first run ' +
      'the panel says so in words.',
    diffRerun: 'Rerun the failures',
    diffRerunText:
      'Starts a run over exactly the red cases of the record — failures and blocks, each one ' +
      'once. The button sits on the record itself and works even for the first run, which has ' +
      'nothing to compare itself with.',
    diffRecheck: 'Recheck closed defects',
    diffRecheckText:
      'On the coverage tab “Refresh defect states” brings the list of “the case is red while ' +
      'the defect is already closed”. The button next to it runs exactly that list: a case ' +
      'status is still changed only by a run, never by the tracker.',
    diffComparableTitle: 'Different plans and environments mean different sets',
    diffComparableText:
      'If the runs went by different plans, in different environments or in different modes, ' +
      'the panel still compares them but says so plainly: “fixed” in such a comparison often ' +
      'means “not run this time”.',

    importTitle: 'CI results and exchanging cases',
    importCaption:
      'Automated tests are run by CI, not by the panel. So that there is one report, their ' +
      'results are pulled in here as a file — with the “Exchange” button above the library ' +
      'or with `pnpm tests` in a terminal.',
    importResults: 'Importing results',
    importResultsText:
      'JUnit XML, the Playwright report and Allure. The panel writes a run record marked ' +
      '"from CI" and sets the case statuses — nothing is launched in the process.',
    importCases: 'Importing cases',
    importCasesText:
      'CSV, XLSX and a TestRail export. That is how a set from an old TMS moves into the ' +
      'project at once instead of being retyped by hand. One more format — “Manual cases ' +
      '(ТК-*.md)”: files written straight in the repository. A FOLDER is given (empty — QA), ' +
      'the number from the file name becomes the case id, folders become sections, and a ' +
      'repeated import edits the same case instead of adding a second one.',
    importExport: 'Export',
    importExportText:
      'A group is exported to CSV, XLSX or Markdown — to attach to a report, to review, or ' +
      'to agree with people who have no panel. A RUN REPORT is exported separately (.md or ' +
      '.csv), straight from the run history: the circumstances, the totals and what was seen ' +
      'at every failure.',
    importMatchTitle: 'Matched by the test name',
    importMatchText:
      'A CI result lands on a case through the automation.testName field. No match — and the ' +
      'panel lists the unmatched ones outright instead of staying silent: a quietly lost ' +
      'result is worse than a missing one.',

    coverageTitle: 'Coverage matrix',
    coverageCaption:
      'The only view that answers “what are we not testing at all”. The case list answers ' +
      'the opposite question, and a hole is invisible in it: a case that does not exist is ' +
      'not in the list of cases by definition.',
    coverageLinks: 'Requirements from links',
    coverageLinksText:
      'A row is a requirement at least one case links to (a link of type requirement or ' +
      'issue). The Jira key is taken out of the address, so /browse/QA-42 and a link from ' +
      'an email are one requirement, not two half-covered columns.',
    coverageJira: 'Requirements from Jira',
    coverageJiraText:
      'With Atlassian connected the panel pulls issues by the JQL of the project ' +
      'attachment. Those bring the important part: issues nobody linked to. Not connected ' +
      '— the matrix says plainly that it shows only what is already linked.',
    coverageOrder: 'Rows ordered by risk',
    coverageOrderText:
      'Uncovered first, then failed and blocked, then untested, then green. The top rows ' +
      'are what the matrix is opened for.',
    coverageOrphans: 'Cases without a requirement',
    coverageOrphansText:
      'A separate list below. Not an error: regression and robustness checks often belong ' +
      'to no issue. But until a case links to something, no release-readiness report will ' +
      'ever see it.',
    coverageArchivedTitle: 'An archived case covers nothing',
    coverageArchivedText:
      'Archived cases are out of the matrix. A requirement covered only by an archived ' +
      'case is covered by nothing — showing it as closed would lie exactly where the ' +
      'reader came to look.',

    quarantineTitle: 'Quarantine',
    quarantineCaption:
      'A known breakage must not colour every run: otherwise the report stops being read ' +
      'at all, and the real failures go with it.',
    quarantineWhat: 'What it does',
    quarantineWhatText:
      'The case runs as usual, gets its real status and stays visible in the list. Exactly ' +
      'one right is taken away — colouring the run.',
    quarantineReason: 'The reason is mandatory',
    quarantineReasonText:
      'Stored next to the flag: why and until when. Without it, in a month nobody ' +
      'remembers whether a login fix was expected here or people just got tired of red.',
    quarantineCi: 'CI does not fail on it',
    quarantineCiText:
      'In the junit export a quarantined case goes out as skipped with its reason, and ' +
      '“pnpm tests report” does not count it as a failure and does not exit 1. The gate ' +
      'stays on and keeps catching everything else.',
    quarantineFilter: 'Quarantine is visible',
    quarantineFilterText:
      'The library has a quarantine filter and a mark on the row, the report has a ' +
      'counter. A silent quarantine is no better than a deleted case.',
    quarantineNotArchiveTitle: 'Not an archive, not a skip',
    quarantineNotArchiveText:
      'Archiving removes the case from work, skipping removes it from the run. Quarantine ' +
      'keeps both: the case is checked, the result is visible, and a known breakage does ' +
      'not block the release. One click clears the flag and a failure counts again.',

    ageingTitle: 'Self-cleaning quarantine and ageing',
    ageingCaption:
      'Quarantine with no expiry is a silent deletion of the case, and a set nobody revisits ' +
      'drifts away from the app in half a year and starts lying in green. The «Quarantine and ' +
      'ageing» card in the report counts both.',
    ageingLift: 'Ready to come back',
    ageingLiftText:
      'A muted case with five greens in a row: the breakage it was muted for no longer ' +
      'reproduces. A failure breaks the streak; a skip neither extends nor breaks it — «was ' +
      'not run» is not the same as «failed».',
    ageingMute: 'Worth muting',
    ageingMuteText:
      'Stability below 70% over four or more results: the case flips green and red on the same ' +
      'code, and nobody believes its failures any more. The reason comes prefilled with the ' +
      'numbers and is edited by hand — without it the button stays disabled.',
    ageingStale: 'Drifted from the requirement',
    ageingStaleText:
      'The tracker issue was edited after the case, so the case checks yesterday’s ' +
      'requirement. Dates come from Jira by the links of the cases; without Atlassian the ' +
      'panel says plainly that it did not check, and still counts the quarantine suggestions.',
    ageingNotRun: 'Not run for a long time',
    ageingNotRunText:
      'A separate line in set health: the case has not been run for over 90 days, and the ' +
      'status shown proves nothing any more. The case itself opens from that line.',
    ageingManualTitle: 'No suggestion applies itself',
    ageingManualText:
      'The panel names the case, the threshold and the button — the human presses it, and ' +
      'presses an ordinary bulk action. Automation that lifts quarantine by a count of greens ' +
      'will one day return a case that was muted deliberately, and you learn of it from a red ' +
      'release.',

    riskTitle: 'Risk and time: what to run if you have half an hour',
    riskCaption:
      'Running everything fits into no working day, and picking by priority alone ignores ' +
      'history: a case that failed yesterday matters more than the same case green for a ' +
      'year. The «by risk» order in the library is computed from five multipliers, each of ' +
      'them named in the tooltip on the score: risk = priority × last outcome × instability × ' +
      'age × diff hit.',
    riskPriority: 'Priority',
    riskPriorityText:
      'A blocker costs more than a detail on any day. Priority is one of the five ' +
      'multipliers here, not the first sort key: a green blocker ranks below a red «high», ' +
      'and that is not a bug — priority says how important a case is in general, history says ' +
      'how important it is today.',
    riskOutcome: 'Last outcome',
    riskOutcomeText:
      'Failed and blocked go up, unchecked follows, green sits below. Quarantine pushes a ' +
      'case down the hardest — its failure is known in advance and does not colour the run — ' +
      'but never to zero, because quarantine gets lifted.',
    riskInstability: 'Instability',
    riskInstabilityText:
      'The share of runs without a change of outcome, from the `runs/` history. A case that ' +
      'is green then red on the very same code proves nothing either way. A steady case is ' +
      'not free either: «always green» is a statement about yesterday’s code.',
    riskAge: 'Age',
    riskAgeText:
      'Days since the last run, up to a month; beyond that the multiplier stops growing. A ' +
      'case that was never run gets the maximum.',
    riskImpact: 'Diff hit',
    riskImpactText:
      'The same diff selection as «run what is affected»: the case `codePaths` against `git ' +
      'status` of the working copy. Not a repository — the multiplier simply stays silent and ' +
      'the other four are computed as usual.',
    riskBudgetTitle: '«I have N minutes»',
    riskBudgetText:
      'The «Fill» button checks what fits: cases are taken by descending risk while the sum ' +
      'of `duration` fits the budget. A case without its own estimate counts as five minutes ' +
      '— the assumption is stated out loud. The sum never exceeds the budget, and what was ' +
      'left out is written in a line: hover it to see the list. No run is started — the ' +
      'checkmarks are on screen and the usual run button launches them.',
    riskUnknownTitle: 'Not knowing is a risk too',
    riskUnknownText:
      'A case without a single run does not get zero risk but an elevated one: you cannot ' +
      'even say it worked once. A library sorted by risk starts with failures and the ' +
      'unchecked, it does not end with them: a fresh failure is never discounted for age.',

    releaseTitle: 'Milestones and releases',
    releaseCaption:
      'Without a milestone the report only answers “how are things now”. The question ' +
      'asked is “what has been tested in this release” — a different one.',
    releaseSet: 'A milestone on the run',
    releaseSetText:
      'A field at start: v1.4, “sprint 12”, a release name. Runs without one work as ' +
      'before and simply stay out of the release summary.',
    releaseTag: 'Taken from a git tag',
    releaseTagText:
      'Not filled in by hand — the nearest tag on the run’s commit is used. A team that ' +
      'already tags does nothing extra for the report.',
    releaseUntested: 'The number that matters is untested',
    releaseUntestedText:
      'The report tab shows per milestone: how many runs, how many passed, how many ' +
      'failed, and how many cases no run of that milestone touched. The last one answers ' +
      '“can we ship”.',
    releaseDoc: 'Readiness as one document',
    releaseDocText:
      'The “Release readiness” card on the report tab: the verdict on one line, then what ' +
      'blocks it (untested cases and open defects), then requirements, failures and the ' +
      'runs of the milestone. Computed from the runs of THIS milestone: a case that turned ' +
      'green in another branch does not improve readiness.',
    releaseVerdictTitle: 'The verdict signs nothing off',
    releaseVerdictText:
      '“Ready to ship” means exactly one thing: nothing listed blocks it — no failures, no ' +
      'untested cases, no open defects, and at least one run of the milestone happened. The ' +
      'decision stays with a human, so every reason is spelled out on its own line. A ' +
      'failure of a quarantined case does not colour the verdict but is stated out loud: ' +
      'its right to colour a run was removed deliberately.',
    releasePrintTitle: 'Printed by the browser on this machine',
    releasePrintText:
      'MD goes into the MR, HTML is read as is, PDF goes to acceptance and the customer. ' +
      'The PDF is drawn by Chrome, Edge or Chromium found on this machine — the same path ' +
      'as the run report. No browser — the panel says what to install, and MD and HTML work ' +
      'without it.',

    secretsTitle: 'Stand credentials',
    secretsCaption:
      'A run against a real environment stops at the login form. Putting the password into ' +
      'the project file is not an option — it would travel to everyone through git.',
    secretsWhere: 'The «Credentials» button by the environment picker',
    secretsWhereText:
      'They belong to the environment currently selected in the run bar — the one the run ' +
      'will use. Nothing selected means the default environment.',
    secretsSplit: 'Name to the project, value to the panel',
    secretsSplitText:
      '`environments.json` carries only the variable name and a note saying what it is for. ' +
      'The value is stored encrypted inside the panel on this machine, next to provider keys.',
    secretsRun: 'How the agent gets them',
    secretsRunText:
      'Values go into the run process environment. The prompt lists only the names — enough ' +
      'for the agent to read them itself.',
    secretsMissing: 'A missing value does not cancel the run',
    secretsMissingText:
      'A colleague who cloned the repository sees the declared name and «not set». The run ' +
      'starts anyway but writes into the log which variable was missing, so a failed login ' +
      'does not look like a broken application.',
    secretsShowTitle: 'The value is never shown back',
    secretsShowText:
      'Only a mask and a «set» flag leave the server: a password can be replaced or ' +
      'forgotten, never read. Should it appear in the agent output, the panel blanks it out ' +
      'in the log, in the case note and in the run history.',
    secretsReservedTitle: 'The panel’s own variables are taken',
    secretsReservedText:
      'ANTHROPIC_API_KEY, CLAUDE_*, PATH and the like are refused as stand credentials: the ' +
      'first would change the account the panel pays with, the second would break launching ' +
      'the CLI. Name the credential your own way, e.g. STAND_PASSWORD.',

    defectsTitle: 'Defects',
    defectsCaption:
      'A failure should turn into an issue while it is still fresh in your head what exactly ' +
      'broke.',
    defectStep1: 'Assemble the draft',
    defectStep1Text:
      'The panel builds the title and the body from the case: the steps, the expectation, ' +
      'what was actually seen, the tail of the run log and the attached evidence.',
    defectStep2: 'Read it and fix it',
    defectStep2Text:
      'The draft opens for editing. Nothing goes out until you have read it — the title of ' +
      'an issue is read more often than its body.',
    defectStep3: 'File it in the tracker',
    defectStep3Text:
      'The issue is created in GitHub or GitLab by whichever CLI is installed (gh or glab), ' +
      'under your name. The link to it is stored in the case. Neither installed — the panel ' +
      'says plainly what is missing.',

    externalTitle: 'Outward: tracker, wiki, reports',
    externalCaption:
      'Four buttons that appear once the integrations are configured and the project is ' +
      'attached to something. How to set that up is in the Integrations article.',
    externalDefect: 'Where a defect goes',
    externalDefectText:
      'The list of targets in the defect window comes from the server: Jira, the token ' +
      'forge, gh, glab. With no target at all the draft is still assembled, and a “Copy” ' +
      'button sits next to it.',
    externalDefectState: 'Is the defect already closed?',
    externalDefectStateText:
      'The “Check defects” button asks Jira or the forge about the issues attached to the ' +
      'red cases and builds the “recheck” list. The case status is not touched: only a run ' +
      'sets it.',
    externalPublish: 'Publish the report',
    externalPublishText:
      'Inside an expanded run record: as a Confluence page or a Jira comment. Where ' +
      'exactly is decided by the project attachment, and the answer carries the address.',
    externalPdf: 'Download a PDF',
    externalPdfText:
      'Next to md and csv — for the people you cannot send markdown to. It is rendered by ' +
      'a browser on this machine; with none installed the panel refuses and names what to ' +
      'install.',
    externalBaseline: 'Compare against a baseline',
    externalBaselineText:
      'A result with screenshots shows before / after / diff side by side and an “Accept ' +
      'baseline” button. Accepting is manual only: otherwise every difference silently ' +
      'becomes the new normal.',

    cliTitle: 'The same things from a terminal',
    cliCaption:
      'Cases are files inside the project, so everything the panel does with a mouse can be ' +
      'called without it — «pnpm tests» in the checked project. In CI, where there is no ' +
      'panel at all, that is the only way to reach them.',
    cliLint: 'pnpm tests lint',
    cliLintText:
      'The same findings as the library health card: cases with nothing to prove them, stale ' +
      'drafts, repeats. It fixes nothing — it names the case and the button. The build turns ' +
      'red only with «--fail-on error | warning | info»: «worth a look» and «must not ship» ' +
      'are different claims, and the second one is yours to make.',
    cliDiff: 'pnpm tests diff <base> <new>',
    cliDiffText:
      'The run comparison of the history tab, as text or junit («--reporter junit»). It ' +
      'returns 1 for NEW failures only: a long-known breakage would otherwise paint every ' +
      'later build red. Arguments in the wrong order are swapped out loud, not silently.',
    cliPlan: 'pnpm tests plan smoke | diff | release | flaky',
    cliPlanText:
      'A plan built by rule, with no panel and no agent: «--budget» for smoke, «--release» ' +
      'for a milestone, «--threshold» for flaky ones. It also lists what did NOT fit and ' +
      'why; «--save» writes the plan into the project. Jira requirements are not consulted ' +
      'from a terminal — the token lives in the panel — and the command says so.',

    limitsTitle: 'Limits and refusals',
    limitsCaption:
      'On the left is what you saw on screen, on the right why it is so. Almost ' +
      'everything here is a deliberate refusal rather than a fault: the panel would ' +
      'rather say “nothing” than pretend it counted.',
    limitColumn: 'What you saw',
    limitMeaningColumn: 'Why it is so',
    limitChanged: '“The working tree edits matched no case”',
    limitChangedText:
      'That is how “Changed only” works: the panel takes the changed files of the ' +
      'working tree and matches them against the cases’ code links and area word. ' +
      'Nothing matched — the list is empty, and that is NOT “run everything”. Common ' +
      'causes: the cases have no codePaths, the edits lie outside those paths, or the ' +
      'changes are already committed and the tree is clean.',
    limitEmptyRun: 'The run ended with an empty record',
    limitEmptyRunText:
      'The panel keeps no counter of its own: the record is assembled from the case ' +
      'files. It fingerprints the selected cases at the start and stamps the ones that ' +
      'changed at the end. A case the executor never touched is not in the record — an ' +
      'empty record means “the agent marked nothing”, not “the panel lost it”. ' +
      'Generation and exploration produce no results at all. A run that never started is ' +
      'another matter: say a required contour is active in the panel while its gateway is ' +
      'down or its key is not saved. The agent then does not start around the contour, the ' +
      'run ends with an error, and the error names the reason and what to press.',
    limitMuted: 'A red case does not redden the gate',
    limitMutedText:
      'Quarantine. The case runs, its status is real, it stays visible — but pnpm tests ' +
      'report does not count it as a failure and does not exit 1, and the junit export ' +
      'carries it as skipped with the quarantine reason. Want a red gate — lift the ' +
      'quarantine, do not delete the case.',
    limitBusy: 'The run buttons are disabled',
    limitBusyText:
      'The suite is busy: a run is already going for this project, or a manual session ' +
      'is open. Two records of one suite would diverge in the files, so a second run ' +
      'does not start until the first is closed or abandoned.',
    limitGenerate: 'Generation wrote nothing',
    limitGenerateText:
      'By design: proposals land in a draft, not in a group. Until you accept them one ' +
      'by one (or turn on “accept at once”), nothing in the project files changes, and ' +
      'the acceptance can be undone as a whole.',
    limitCoverage: 'A requirement nobody covered is not shown',
    limitCoverageText:
      'Without Atlassian there is one source of requirements — the cases’ own links — ' +
      'and by construction it cannot show a requirement nobody linked. A connected ' +
      'integration adds issues by a JQL query; until then the panel says so right under ' +
      'the table. Archived cases are excluded: a requirement covered only by an ' +
      'archived case is covered by nothing.',
    limitArchived: 'A case disappeared from the list',
    limitArchivedText:
      'It is most likely archived or filtered out. The “Show archive” toggle brings ' +
      'archived cases back into view; they are out of runs and out of coverage, but ' +
      'still in the file and one action away.',
    limitReserved: 'A field will not save or gets renamed',
    limitReservedText:
      'The name is taken by the format: a custom field cannot be named like a system ' +
      'one. The panel names the taken word in the refusal — give your field another one.',
    limitHonestTitle: 'The panel applies nothing by itself',
    limitHonestText:
      'Not quarantine by instability, not lifting quarantine after green runs, not ' +
      'marking a case stale, not closing a defect. Thresholds are computed and shown; ' +
      'the button is pressed by a human. The same rule holds for the milestone verdict: ' +
      'the panel says “too early” or “ready to ship”, but signs nothing and lets nobody ' +
      'through.',

    canLibrary: 'Keep the library: groups, sections, cases, checklists, shared steps, parameters',
    canPlans: 'Assemble test plans and environments and expand them into test points',
    canManual: 'Walk cases by hand with per-step marks, notes and attachments',
    canAgent: 'Start the agent: generate, run, explore, automate',
    canDraft: 'Accept generated proposals one by one and undo the acceptance wholesale',
    canImport: 'Pull automated results from CI and exchange cases as files',
    canDefect: 'File a defect for a failure in GitHub or GitLab',
    canCoverage: 'Read the coverage matrix: requirement → cases → result, holes on top',
    canQuarantine: 'Keep a known breakage in quarantine without failing the run or CI',
    canRelease: 'Count what a milestone covered: its runs and the cases it never touched',
    canPhone: 'Do all of it from the phone: the same project, the same manual session',

    cantDatabase: 'A case database of its own — the source of truth is the project files',
    cantSchedule: 'Scheduled runs — CI runs on a schedule, the panel pulls the result',
    cantMerge:
      'Merging branches with cases — conflicts are settled by git, like the rest of the code',
    cantUsers: 'Accounts and roles — the panel is local and works under your name',

    undoTitle: 'How to undo and remove',
    undoCaption:
      'Almost nothing here is irreversible: the suite is project files, and files have ' +
      'git. Below is what a button undoes and what a commit does.',
    undoQuarantine: 'Lift the quarantine',
    undoQuarantineText:
      'Tick the case, action “lift quarantine”. The status, the history and the links ' +
      'stay where they were — the case regains the right to colour the verdict and the ' +
      'gate.',
    undoArchive: 'Bring a case back from the archive',
    undoArchiveText:
      'Turn on “Show archive”, tick the case, action “restore from archive”. Archiving ' +
      'deletes nothing: the case was in the same group file the whole time.',
    undoDraft: 'Undo an accepted generation',
    undoDraftText:
      'Accepted proposals roll back as a whole in one action while the run draft is ' +
      'still there. An unaccepted draft can simply be thrown away — nothing of it is ' +
      'left in the group.',
    undoRun: 'Abandon a manual pass',
    undoRunText:
      '“Abandon” closes the session without writing a run record. The statuses already ' +
      'marked stay: they live in the case files, not in the session.',
    undoGroup: 'Delete a group',
    undoGroupText:
      'The whole group file goes, with its cases and their status history. This is the ' +
      'only genuinely large deletion in the section — and the only one worth doing on a ' +
      'clean working tree.',
    undoConvention: 'Remove the note from the project CLAUDE.md',
    undoConventionText:
      '“Write into the project CLAUDE.md” adds a paragraph about where the cases live ' +
      'and how they are kept. It is an ordinary edit of an ordinary file: remove it by ' +
      'hand or revert it with git.',
    undoGitTitle: 'The last undo is git',
    undoGitText:
      'Cases, runs and attachments live in .agent/tests and travel into a commit with ' +
      'the code. Every action of the section is a file edit, so git diff shows what ' +
      'changed, git checkout brings it back, and a case’s history reads with git log ' +
      'without any panel at all.',

    notesTitle: 'Things people trip over',
    noteBrokenTitle: 'A broken group file',
    noteBrokenText:
      'If the JSON did not parse, the panel blacks out ONLY that tab and leaves the file ' +
      'alone: somebody’s work stands behind it, and fixing it by a silent rewrite means ' +
      'losing that work. The other groups work as usual.',
    noteStatusTitle: 'The status is the last result, not a history',
    noteStatusText:
      'A case holds how the last run ended: the question people ask is "what is red right ' +
      'now". Everything else — trends, flakiness, coverage — is computed from the records in ' +
      'runs/, and those live separately.',
    noteHumanTitle: 'The agent does not delete your cases',
    noteHumanText:
      'A case you wrote is marked source: human, and the agent is forbidden to delete or ' +
      'rewrite it — only to extend it. Its own cases it creates, updates and removes itself ' +
      'when a feature is gone from the app.',
    noteGitTitle: 'Versions, review and conflicts — through git',
    noteGitText:
      'There is deliberately no versioning mechanism of its own. An edit to a case shows in ' +
      'the diff, is discussed in an MR and is reverted like ordinary code. Old files keep ' +
      'parsing meanwhile: steps as strings, a case without a type, a status spelled ok.',
  },
  shots: {
    workspace: {
      '01-empty':
        'The section with no cases: the console on top and the three steps that start a suite',
      '02-environment':
        'The environment step is closed: “Local” is picked, passwords live behind “Access”',
      '03-group': 'A group is one field: “smoke” becomes the file name smoke.tests.json',
      '04-case':
        'The whole case form: purpose, area and section, steps with expectations, oracle and tags',
      '05-library':
        'Six cases in the library, all “not run”, with filters and the section tree on the left',
      '06-runner':
        'The manual run, case 1 of 6: steps with expectations, outcome buttons and the timer',
      '07-runner-failed':
        'Case 2 fails: the red step is marked and the note says what actually happened',
      '08-library-after': 'The same library after the run: 5 passed, 1 failed, the counter on top',
      '09-run-record': 'The run record: who ran it, what each case ended with, reports next to it',
      '10-report': 'The Report tab: case states, automation coverage and the suite totals',
    },
    health: {
      '01-changed-only':
        '“Changed only” on a clean tree: the panel says plainly that it matched no case',
      '02-quarantine':
        'One case selected, action “quarantine” — and the reason field it will not skip',
      '03-muted': 'A quarantined case stays failed: the status is real, the reason sits in the row',
      '04-release':
        'The milestone verdict “Ready to ship” beside the line “Failures in quarantine: 1”',
      '05-health':
        'Further down the same tab: failure evidence, the suite linter and quarantine thresholds',
      '06-coverage':
        'Requirement coverage: two requirements from case links and two cases with none',
      '07-exchange':
        'Importing CI results: the format, the file in the project and what the report matched',
      '08-runs-import':
        'In the run history the import is its own record, signed as someone else’s run',
    },
  },
  diagrams: {
    'where-cases-live':
      'Where the suite lives and who writes into it: a human, a CLI agent and someone else’s CI run all put their result into the project’s own files. The section has no database.',
    'what-turns-red':
      'What turns the milestone verdict red and what quarantine does not: the two paths of one failure — an ordinary one, and one stripped of the right to colour the gate.',
  },
};
