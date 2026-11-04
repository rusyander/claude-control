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
      'The panel and the core are two processes. Pages reach the core only through the panel: the ' +
      'proxy `/api/core/*` and the chat start route.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A page sends a request to the panel. The proxy finds the running core by its record, ' +
      'checks that the port really belongs to it and forwards the request with the core’s access ' +
      'key. The event stream comes back unbuffered. If the core is just starting, the request waits ' +
      'for it up to 15 s. A new chat is started not through the proxy but through the panel route ' +
      '`/api/chat/core-start`: the panel adds its own layer to the estimate (the Tests block line, ' +
      'the kit, the flags of its own layers) and forwards it to the core with the same page proof. ' +
      'A body signed with the phone key goes through the proxy as is: the additions would break ' +
      'the signature. The core accepts human commands from the panel process recorded to it ' +
      'as a hop, or with a phone key signature.',

    startTitle: 'Starting the core',
    startCaption: 'The panel starts the core itself: no separate command is needed.',
    startRun: 'The panel starts the core and watches it',
    startRunText:
      'On start the panel finds a live core on this machine — started by `pnpm core`, by OS ' +
      'autostart or by a previous panel — and takes it under supervision; with no core it starts ' +
      'its own. The core is a separate process and outlives a panel restart. If it crashes, the ' +
      'panel starts it again after a pause of 1 to 60 s, and started tasks carry on with their ' +
      'sessions. A second panel on the same machine starts no second core: both work with one. The «Start the core at sign-in» toggle ' +
      'above the task list sets up autostart (Windows Task Scheduler, systemd, macOS LaunchAgent).',
    startOpen: 'Open «Core tasks»',
    startOpenText:
      'A sidebar entry. The list shows the core’s tasks: whether a task is running now, its state ' +
      'and a link to its timeline. The header buttons lead to the launch screen and to scenarios.',
    startFault: 'The core does not start — a fault card',
    startFaultText:
      'While the core is starting, the list is replaced by the «The task core is starting» card; ' +
      'the page refreshes itself once the core answers. Five crashes within 10 minutes and the ' +
      'panel stops starting the core and shows the «The task core does not start» card: the last ' +
      'exit code, the tail of the core log (secrets hidden) and a «Restart» button that resets ' +
      'the failure count.',
    startAbsent: 'Supervision off — the «not running» card',
    startAbsentText:
      'The «The task core is not running» card appears only for a panel with supervision off ' +
      '(`AGENTDECK_CORE_SUPERVISE=0` — QA stands with their own core): whoever turned supervision ' +
      'off starts the core, for example with `pnpm core`.',
    cmdHeader: 'Command',
    cmdWhat: 'What it does',
    cmdCore: 'pnpm core',
    cmdCoreText:
      'Starts the core by hand — the developer’s way. The panel finds such a core and takes it ' +
      'under supervision instead of starting a second one.',
    cmdDev: 'pnpm dev',
    cmdDevText:
      'Starts the panel; the panel starts the core itself and records its processes to it as hops.',
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
      'is off: the core does not wait for the pipeline unless you ask for this task. The work runs ' +
      'in a copy of the repository: the core changes the main project folder only in a chat you ' +
      'started yourself — starting the chat is your permission. Press «Estimate».',
    launchReview: 'Review an MR by link',
    launchReviewText:
      'Paste a GitLab MR or GitHub PR link and the path of the repository it lives in, then «Open the ' +
      'review». The core matches the link against the repository remote and opens a task on the MR ' +
      'branch: a review, then a question in the feed — fix, post one summary note to the MR, both, or ' +
      'nothing. A refusal is named on a plate: not an MR link, an MR of another project, a closed MR, ' +
      'a remote with no forge API (the last one is in the shot).',
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
    launchMcp: 'MCP servers for steps',
    launchMcpText:
      'Below the routes — your own MCP servers from each CLI config (the user layer). A tick gives ' +
      'the server to a step kind in every following task; without a tick the step sees only the ' +
      'core servers. Chat takes every offered server by default. A server no CLI offers is marked: ' +
      'the core drops it at launch and names the reason in the journal. Read-only kinds take no ' +
      'human servers. Two CLIs do not get the ticked servers, and the journal names it as a loss ' +
      'by name: Gemini CLI starts no MCP in an untrusted folder, and the step copy is not trusted ' +
      'for it; for Cursor, starting a server without a prompt is not proven live. Saving writes ' +
      'the whole core config; if it changed meanwhile, the core ' +
      'refuses and the card shows why.',
    launchDiagramTitle: 'From form to steps',

    askTitle: 'Answering the core’s questions',
    askCaption:
      'Open questions sit above the task timeline. An answer is one click; a second click does ' +
      'not send a second command. An open question also arrives as a notification — on the phone ' +
      'and in Telegram, with a link to the task; you can answer in the panel timeline or on the ' +
      'phone, where the answer is signed with the phone key.',
    askLaunch: 'The launch question',
    askLaunchText:
      'If a task was estimated but not launched from the launch screen, the core asks here: ' +
      '«Approve the split» launches the task; editing the split is done on the launch screen.',
    askCap: 'A step ran out of rounds',
    askCapText:
      'The step failed as many times as the scenario allows. The question and its answer options ' +
      'come from the core, in the language of the panel the task was launched from (the same goes ' +
      'for the step time and budget questions); under the card — the core’s reply: «accepted» or ' +
      'its words on why not.',
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
      'The core accepts human commands — answers, launch, saving a scenario — from a panel process ' +
      'recorded to it as a hop, or with a phone key signature. The hop is recorded by the launch ' +
      'watchdog (`pnpm dev`, `pnpm keepalive`) or, without one, by the panel’s own supervision, ' +
      'for every new core. If the record did not arrive, pages show this notice and commands ' +
      'without a phone signature are refused with `signature-required`.',
    hopsDo: 'What to do',
    hopsDoText:
      'Wait a minute: the panel records itself to the core on its own. If the notice stays, ' +
      'restart the panel (`pnpm dev` or `pnpm keepalive`). The core does not need a restart: the ' +
      'new record replaces the old one. Reading — the list, the timeline, the report — works ' +
      'without a record.',

    limitsTitle: 'What the section cannot do yet',
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
    fault: {
      '01-fault':
        'The core does not start: the last exit code, the log tail and a «Restart» button',
    },
    absent: {
      '01-card': 'Supervision off: the «The task core is not running» card instead of the list',
    },
    launch: {
      '01-form': 'Launch form: title, requirements, repository, scenario; no CI wait',
      '02-estimate': 'Estimate: time, tokens and spread; without run history — «unknown»',
      '03-roads': 'Road check: where each CLI was found, route, disk, memory, ports, git',
      '04-rejected': 'A rejected edit: the repository file tried to turn on the CI wait',
      '05-split': 'Splitting into parts: part, repository, own paths; the core check mark',
      '06-launch': 'The «Launch» button is open: the split is ready, no unconfirmed access',
      '07-review-link':
        'Review by link: the remote has no forge API — the core names the reason before launch',
      '08-mcp-picks':
        'MCP servers for steps: one ticked for fixes, chat «every offered», a pick nobody offers',
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
