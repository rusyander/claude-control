import type { coreRu } from '../../ru/topics/core';

/** Help for the «Core tasks» section; typed against the Russian module. */
export const coreEn: typeof coreRu = {
  topic: {
    title: 'Core tasks',
    summary:
      'A separate process that takes a task from estimate to report: launch, a timeline with the reasons for each decision, questions to you, scenarios',
    lead:
      'The task core is a separate process next to the panel. It estimates a task, splits it into ' +
      'parts, runs the steps through a CLI, checks the result and writes every decision to the ' +
      'task journal together with its reason. The panel decides nothing for the core: it shows ' +
      'the journal as a timeline, asks the core questions and passes your answers on.',

    guideTitle: 'What this document covers',
    guideText:
      'First a diagram — how panel pages reach the core. Then how to start the core, the launch ' +
      'screen step by step, answering questions, reading the timeline and scenarios. At the end — ' +
      'what the «not running» card and the «the core does not know this panel yet» notice mean, ' +
      'and what the section cannot do yet.',

    whyJournal: 'A task lives in its journal',
    whyJournalText:
      'Everything the core did and decided is a journal line. The timeline shows that journal, not ' +
      'a retelling: reloading the page or restarting the panel loses nothing, the stream resumes ' +
      'where it broke off.',
    whyReason: 'Every decision has a «why»',
    whyReasonText:
      'A decision line is a short headline in the interface language, with the core’s reasons ' +
      'verbatim under «details». You can see why a check ran in full or replayed a record, why a ' +
      'step started over, why the task is waiting.',
    whyHuman: 'You decide — at named points',
    whyHumanText:
      'Launch, exhausted rounds, permission to edit, a question from the model — the core stops ' +
      'and waits for an answer on a card above the timeline. The answer goes to the core as a ' +
      'command and lands in the same journal.',

    mapTitle: 'How pages reach the core',
    mapCaption:
      'The panel and the core are two processes. Pages go only through the panel proxy `/api/core/*`.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A page sends a request to the panel. The proxy finds the running core by its record, ' +
      'checks that the port really belongs to it and forwards the request with the core’s access ' +
      'key. The event stream comes back unbuffered. The core accepts human commands from the ' +
      'panel process that is recorded to it as a hop; starting the panel makes that record.',

    startTitle: 'Starting the core',
    startCaption: '`pnpm dev` starts the panel but not the core: the core has its own command.',
    startRun: 'Start the core',
    startRunText:
      'In the repository root, in a separate terminal: `pnpm core`. The core runs while that ' +
      'terminal is open; the panel finds it on its own.',
    startOpen: 'Open «Core tasks»',
    startOpenText:
      'A sidebar entry. The list shows the core’s tasks: whether a task is running now, its state ' +
      'and a link to its timeline. The header buttons lead to the launch screen and to scenarios.',
    startAbsent: 'Core not running — a card, not an error',
    startAbsentText:
      'Without a core the list is replaced by the «The task core is not running» card naming ' +
      '`pnpm core`. Start the core and refresh the page.',
    cmdHeader: 'Command',
    cmdWhat: 'What it does',
    cmdCore: 'pnpm core',
    cmdCoreText: 'Starts the task core. Without it the section only shows the «not running» card.',
    cmdDev: 'pnpm dev',
    cmdDevText:
      'Starts the panel and records its processes to the core as hops. Does not start the core.',
    cmdKeepalive: 'pnpm keepalive',
    cmdKeepaliveText:
      'Keeps the panel running and restarts it after a crash; also records hops to the core.',

    launchTitle: 'The launch screen',
    launchCaption:
      'A task is born from an estimate: the core counts, checks the roads and proposes a split; ' +
      'launching is your decision.',
    launchForm: 'Fill in the form',
    launchFormText:
      'Title, the full requirements, repository path and scenario. «Wait for CI after publishing» ' +
      'is off: the core does not wait for the pipeline unless you ask for this task. Press «Estimate».',
    launchEstimate: 'Estimate',
    launchEstimateText:
      'Time, tokens and spread — from run history. With no history it says «unknown»: the core ' +
      'does not make numbers up. Next to it — the id of the created task.',
    launchRoads: 'Road check',
    launchRoadsText:
      'Everything the task needs to reach the end: where each CLI was found, the model route, ' +
      'disk, memory, ports, git. A CLI not found shows a «CLI path» field («Path to the CLI» on the screen) right there: an ' +
      'explicit path is saved to the core settings and the next estimate checks the road again.',
    launchRejected: 'Rejected edits',
    launchRejectedText:
      'A repository file cannot widen what you or the core set. The core does not apply such ' +
      'values and names them here with the file and the rule.',
    launchSplit: 'Splitting into parts',
    launchSplitText:
      'The core proposes parts: name, repository, own paths. You can edit the parts and save the ' +
      'split; the core’s check marks whether it accepted it.',
    launchGo: 'Launch',
    launchGoText:
      '«Launch» accepts the split and the task starts working. While access is unconfirmed or the ' +
      'split is not ready, the button is closed and the reason is written below it.',
    launchDiagramTitle: 'From form to steps',

    askTitle: 'Answering the core’s questions',
    askCaption:
      'Open questions sit above the task timeline. An answer is one click; a second click does ' +
      'not send a second command.',
    askLaunch: 'The launch question',
    askLaunchText:
      'If a task was estimated but not launched from the launch screen, the core asks here: ' +
      '«Approve the split» launches the task; editing the split is done on the launch screen.',
    askCap: 'A step ran out of rounds',
    askCapText:
      'The step failed as many times as the scenario allows. The answer options come from the ' +
      'core; under the card — the core’s reply: «accepted» or its words on why not.',
    askKindsHeader: 'Question',
    askKindsWhat: 'What the core waits for',
    askKindLaunch: 'launch',
    askKindLaunchText: 'Approve the split and start work.',
    askKindCap: 'round cap',
    askKindCapText: 'Decide what to do with a step that failed the allowed number of times.',
    askKindPermit: 'permission',
    askKindPermitText:
      'Grant access to project paths: the «Grant access» form — project, paths, actions.',
    askKindHuman: 'model question',
    askKindHumanText: 'Answer in text a question the model asked a human.',

    timelineTitle: 'The task timeline',
    timelineCaption:
      'The timeline is the task journal in time order. Spend and limits on the right, the final ' +
      'report below the timeline.',
    timelineOverview: 'Header and columns',
    timelineOverviewText:
      'Task state, outcome and the stream line: «The timeline is live» or «The timeline ' +
      'connection dropped — reconnecting». Timeline rows go in time order: CLI sessions with model ' +
      'and route, steps, checks, decisions, signals. On the right — tokens and cost, the same ' +
      'numbers the core counts.',
    timelineDecision: 'How to read «why»',
    timelineDecisionText:
      'A decision carries a class label («Check», «Next action», «Permission») and an outcome ' +
      'headline. Click «details»: the core’s reasons are there verbatim, in English, exactly as ' +
      'the core wrote them.',
    timelineCheck: 'A check and its record',
    timelineCheckText:
      'Every check is named by mode and reason. The «Record» link opens the check record: ' +
      'verdict, exit code, duration, command.',
    timelineReport: 'Final report',
    timelineReportText:
      'Appears when the task has ended: outcome, units with branches, requirements with marks. ' +
      'The core serves the report only if it matches its record in the journal.',
    checkHeader: 'Check mode',
    checkWhat: 'What it means',
    checkRun: 'Run',
    checkRunText: 'The check ran in full.',
    checkReplay: 'Replay',
    checkReplayText:
      'The tree has not changed since the last check — the core replayed the recorded result and ' +
      'named the record instead of running it again.',
    checkNarrow: 'Narrow',
    checkNarrowText: 'Only the part of the check that touches the change ran.',

    scenariosTitle: 'Scenarios',
    scenariosCaption:
      'A scenario is the task’s chain of steps. Built-in core presets change only with the core; ' +
      'your versions live in the library.',
    scenariosLibrary: 'Library',
    scenariosLibraryText:
      'Core presets and your scenarios, each with versions. Pick a scenario to read its steps or ' +
      'build a new one on top of it.',
    scenariosNew: 'New scenario',
    scenariosNewText:
      'The step editor is the same as the group path editor: steps are dragged, a step has a ' +
      'title, checks and gates. «Save to the library» writes the next version; a written version ' +
      'never changes again — an edit becomes a new version.',
    scenariosTask: 'Editing a running task',
    scenariosTaskText:
      'The «Edit a task» tab changes the scenario of a task that is already running. The new ' +
      'version applies from the next step; the core’s reply stays on screen.',

    hopsTitle: 'The «The core does not know this panel yet» notice',
    hopsCaption:
      'Means: the panel process is not recorded to the core, and it will not accept commands from the panel.',
    hopsWhat: 'What happened',
    hopsWhatText:
      'The core accepts human commands — answers, launch, saving a scenario — only from a panel ' +
      'process recorded to it as a hop. Starting the panel with `pnpm dev` or `pnpm keepalive` ' +
      'makes that record. If the panel was started otherwise or the record did not arrive, pages ' +
      'show this notice and commands are refused with `signature-required`.',
    hopsDo: 'What to do',
    hopsDoText:
      'Restart the panel with `pnpm dev` or `pnpm keepalive`. The core does not need a restart: ' +
      'the new record replaces the old one and the notice goes away. Reading — the list, the ' +
      'timeline, the report — works without a record.',

    limitsTitle: 'What the section cannot do yet',
    limitPhoneTitle: 'Core questions do not reach the phone or Telegram',
    limitPhoneText:
      'You can answer only in the task timeline in the panel. Relaying core questions to the ' +
      'phone and Telegram is the next stage.',
    limitSignTitle: 'Phone signatures for core commands',
    limitSignText:
      'The core does not verify the panel’s phone signatures yet, so human commands go only ' +
      'through a recorded hop.',
    limitEnglishTitle: 'Decision reasons are in English',
    limitEnglishText:
      'The core writes its reasons as English prose and the timeline shows them verbatim: a ' +
      'translation would distort the ground it decided on. Decision headlines are translated.',
    limitNumbersTitle: 'An estimate without history says «unknown»',
    limitNumbersText:
      'The core counts time and tokens from past runs of similar tasks. A new machine has none, ' +
      'and the estimate honestly says «unknown».',
  },

  shots: {
    tasks: {
      '01-list':
        'The «Core tasks» section: the task list with states; «Core scenarios» and «Launch a core task» in the header',
      '02-hops':
        'The «The core does not know this panel yet» notice: the panel process is not recorded',
    },
    absent: {
      '01-card': 'Core not running: a card naming pnpm core instead of the list',
    },
    launch: {
      '01-form': 'Launch form: title, requirements, repository, scenario; no CI wait',
      '02-estimate': 'Estimate: time, tokens and spread; without run history — «unknown»',
      '03-roads': 'Road check: where each CLI was found, route, disk, memory, ports, git',
      '04-rejected': 'A rejected edit: the repository file tried to turn on the CI wait',
      '05-split': 'Splitting into parts: part, repository, own paths; the core check mark',
      '06-launch': 'The «Launch» button is open: the split is ready, no unconfirmed access',
    },
    ask: {
      '01-launch':
        'The launch question above the timeline: «Approve the split» or «Cancel the task»',
    },
    cap: {
      '01-round-cap': 'The «round cap» question: a step failed the allowed number of times',
    },
    timeline: {
      '01-overview':
        'Task timeline: state and stream on top, rows in time order, spend on the right',
      '02-decision': 'A core decision with «details» open: the reasons verbatim',
      '03-check': 'A check with its record open: verdict, exit code, command',
      '04-report': 'The task’s final report: outcome, units, requirements',
    },
    scenarios: {
      '01-library': 'Scenario library: core presets and your versions',
      '02-new': 'A new scenario based on a preset: steps, checks, gates',
    },
  },

  diagrams: {
    'panel-to-core':
      'From panel to core: pages, the /api/core/* proxy, the core and the panel’s recorded hops',
    'launch-to-steps':
      'From launch to steps: form, estimate, split and launch, steps, timeline and questions to you',
  },
};
