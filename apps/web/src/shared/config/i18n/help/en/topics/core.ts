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
      'The panel and the core are two processes. Pages reach the core only through the panel — ' +
      'the proxy `/api/core/*`; a chat turn is run by the panel server itself.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A page sends a request to the panel. The proxy finds the running core by its record, ' +
      'checks that the port really belongs to it and forwards the request with the core’s access ' +
      'key. The event stream comes back unbuffered. If the core is just starting, the request waits ' +
      'for it up to 15 s. Chat does not call the core directly: the panel server receives a ' +
      'message from Chat and creates the core task itself — the chat estimate, the CLI choice, ' +
      'the launch — adding its own layer (the Tests block line, the kit, the flags of its own ' +
      'layers). The tracker issue for the launch screen is read by the panel too, through its ' +
      'Jira connection: the core never calls the tracker. ' +
      'The core accepts human commands from the panel process recorded to it ' +
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
      'In the Task leading block — your own MCP servers from each CLI config (the user layer). A tick gives ' +
      'the server to a step kind in every following task; without a tick the step sees only the ' +
      'core servers. Chat takes every offered server by default. A server no CLI offers is marked: ' +
      'the core drops it at launch and names the reason in the journal. Read-only kinds take no ' +
      'human servers. Two CLIs do not get the ticked servers, and the journal names it as a loss ' +
      'by name: Gemini CLI starts no MCP in an untrusted folder, and the step copy is not trusted ' +
      'for it; for Cursor, starting a server without a prompt is not proven live. Saving writes ' +
      'the whole core config; if it changed meanwhile, the core ' +
      'refuses and the card shows why.',
    launchSource: 'Task source',
    launchSourceText:
      'The Source field above the title. Text — the requirements are the source. Tracker issue — a ' +
      'key like PROJ-12 and Read: the panel reads the issue through the Jira connection in ' +
      'Integrations and shows the title and the number of acceptance criteria from the tracker ' +
      'field; an empty title and requirements are taken from the issue, the core never calls the ' +
      'tracker. Another key removes the text the previous issue filled in (your own edits stay). ' +
      'Voice — dictation goes into Requirements. Several items — each item has its own title and ' +
      'text, plus the How to run the items choice: As one task (the default) — the core analyses ' +
      'the items together; As a group — a task per item — a task for every item in one group. The ' +
      'source goes into the estimate as a snapshot with a digest; the core never fetches it again. ' +
      'Only a lead scenario (Lead, or Tracker issue) reads the snapshot: the estimate refuses ' +
      'another scenario with a source and names the reason instead of dropping it silently.',
    launchGroup: 'A group: estimate and launch',
    launchGroupText:
      'A group estimate names the group and all its tasks with a link to each feed; the numbers ' +
      'and progress below belong to the first task. The lead asks for the intake card of every ' +
      'task: Confirm the group cards answers each waiting one “Confirm the card”, as in its feed ' +
      '(the answer goes to the task journal as yours), and names a task not confirmed with its ' +
      'reason — a retry confirms only the rest. The button never answers the class question ' +
      '(asked when leading settings always ask the class): the class is chosen in the task feed, ' +
      'and the launch section says how many tasks wait for that answer, with a link to each feed. ' +
      'Launch the group starts every task of the group and names a task that did not start with ' +
      'its reason — a retry starts only that one; a group whose launch broke off midway is ' +
      'finished the same way. After that every task of the group runs its own feed, and the core’s ' +
      'shared queue shares the session slots between them.',
    launchLead: 'Task leading',
    launchLeadText:
      'The block at the bottom of the screen: leading settings and MCP servers side by side. Profile ' +
      '— Economy (2 sessions at once), Balanced (the default, 4) or Maximum quality (6, recon and ' +
      'plan one rung higher, review at xhigh). Scope — machine defaults or one project; a project ' +
      'edit is stronger. Details opens the rung, effort and model of each role (effort max is not ' +
      'listed — the core never picks it), sessions at once with the machine limit, the rung raise by ' +
      'learning and what to always ask. There is no spend cap on purpose. Save writes the core ' +
      'config; if it changed meanwhile, the core refuses. A lead estimate names the profile, the ' +
      'class (before recon — decided after recon), sessions at once, the session slot wait and ' +
      'the role rungs; Configure for this project switches the scope to the task project. The ' +
      'slot wait reads: right away — a slot is free, ≈ N s, ≈ N min, or not estimated (no session ' +
      'history, or the slots could not be read); it is counted from the slots taken now and the ' +
      'median length of finished sessions. Learning reset removes a key raise entirely. How the ' +
      'profile, classes and raises work inside a task — the Lead section below.',
    launchDiagramTitle: 'From form to steps',

    leadTitle: 'The lead: how the core runs a task',
    leadCaption:
      'The Lead scenario (and Tracker issue, version two) — recon, intake, class, plan, work, ' +
      'review and integration. The model proposes, one core function decides each time, and every ' +
      'decision with its reason is in the feed.',
    leadPathTitle: 'The same path in words',
    leadPathText:
      'Recon only reads the repository and hands in a map. Intake builds the intake card — the ' +
      'goal, the acceptance points, the forks. The core computes the task class from the map, and ' +
      'the class decides the shape: S — one edit without a plan, M — one unit and a review, L — ' +
      'several units, a review of each and integration, XL — child tasks. Units work in parallel ' +
      'within the session slots; after review and fixes come the final check and publishing. At ' +
      'forks only a human decides, the core stops and asks on a card above the feed.',
    leadRecon: 'Recon',
    leadReconText:
      'The step only reads: it changes nothing and hands in a map — at most 20 lines, the files ' +
      'with why each matters, the tests and the owners. The map carries no file bodies. The plan ' +
      'may read the files it needs itself later.',
    leadIntake: 'Intake and the intake card',
    leadIntakeText:
      'The card is the goal, every acceptance point and up to four open forks, each with a ' +
      'recommendation. The card accepts itself only for a tracker issue with a structured ' +
      'criteria field and no forks — the intake step is skipped then, and the reason is in the ' +
      'feed. Otherwise the core asks one question with all the forks at once: Confirm the card, ' +
      'or stop the task. The task text is data, not a command: a request in it to the session ' +
      'about the core’s own work shows up as the signal «Request text asks the session for core ' +
      'work».',
    leadClass: 'Task class',
    leadClassText:
      'The class is a pure calculation from recorded signs: how many files and units, whether the ' +
      'change is covered by checks, whether a risk rule fired, how many items the source has. No ' +
      'check — the class goes one up. The model may only raise the class; a class it proposes ' +
      'below the calculation is refused and named. Only a human lowers the class. The decision is ' +
      'in the feed as the «Task class» line.',
    leadClassesHeader: 'Class',
    leadClassesWhat: 'When, and which shape',
    leadClassS: 'S',
    leadClassSText:
      'Up to 3 files and one unit, the change covered by a check, no risk rules. No plan; the ' +
      'review stays.',
    leadClassM: 'M',
    leadClassMText:
      'Up to 10 files and up to 2 units, covered by a check. A plan, one unit and a review.',
    leadClassL: 'L',
    leadClassLText:
      'Everything above M that is not XL. The plan splits the work into units, each with its own ' +
      'review; then integration.',
    leadClassXL: 'XL',
    leadClassXLText:
      'From 2 source items, or from 5 units linked to each other. The parts of the split become ' +
      'child tasks.',
    leadAsk: 'What to always ask',
    leadAskText:
      'Under Details in the Task leading block — Always ask: the intake card (never accept it ' +
      'automatically), the task class (a class question in the feed) and the split into parts ' +
      '(the split waits for your approval even when it could pass on its own).',
    leadUnits: 'Units instead of subagents',
    leadUnitsText:
      'Parallel work is done by core units — each with its own session, its own repository copy, ' +
      'a session slot, permissions and a journal — on every CLI. A unit does not call subagents ' +
      'inside its session: permissions refuse with the code `lead-worker`, and work that could ' +
      'have gone to a subagent the plan gives to a separate unit; a mechanical unit with a ' +
      'complete spec runs one rung lower. Units were once meant as a fallback for CLIs without ' +
      'subagents — now they are the only path for every CLI: only a unit can be queued, checked ' +
      'by permissions and counted by spend. In a regular chat, subagents still work.',
    leadParallel: 'How many sessions at once',
    leadParallelText:
      'Economy — 2 model sessions at once, Balanced — 4 (the default), Maximum quality — 6; the ' +
      'count is shared by all tasks and units of the machine. The machine narrows it by its slot ' +
      'limit (6 by default), and a local model route on its own GPU lets one session through. ' +
      'Extra sessions are not refused, they wait: the «Queue — Waiting for a slot» line names who ' +
      'holds the slot and why. Chats are not counted and never wait for a slot. Heavy checks have ' +
      'their own queue.',
    leadSpend: 'No spend cap',
    leadSpendText:
      'There is no spend cap per task and no budget question, on purpose. The core’s observer ' +
      'sees loops, stalled sessions and spend without progress. When spend passes twice the upper ' +
      'bound of the estimate, the feed shows the note «Spend twice the estimate — the task goes ' +
      'on»: it stops nothing and asks nothing. An estimate without history gives no such note — ' +
      'there is nothing to compare with.',
    leadEscalation: 'Escalation after a failure',
    leadEscalationText:
      'An attempt failed (a red check, or a failure at a lowered rung) — the next one runs one ' +
      'rung higher: effort first, up to xhigh, then the next model, up to the CLI ceiling (Opus ' +
      'for Claude). At the ceiling — the same rung, and the «Model» decision says so. There is no ' +
      'retry at the same rung below the ceiling. A reviewer is never weaker than the author. The ' +
      'core never picks effort max; a model above the ceiling is only your pick.',
    leadPromotion: 'Raise by learning',
    leadPromotionText:
      'The core remembers the first passes of every kind of work (project, step kind, CLI, route, ' +
      'model, role). If fewer than 85 % of the last 20 runs (at least 8) pass on the first try, ' +
      'that kind of work goes one rung up — and may keep going up to the ceiling. It never goes ' +
      'back down on its own: Learning reset removes the key raise entirely. The numbers are ' +
      'edited under Details.',
    leadIntegration: 'Integrating the parts',
    leadIntegrationText:
      'With two or more parallel parts, an integration unit merges their branches locally, checks ' +
      'and reviews the combined change — only how the parts fit together. Integration has no MR ' +
      'of its own; the parts publish their MRs only once integration is green, and each MR links ' +
      'the others. A closed part (failed or stopped) is not merged in. A conflict stops ' +
      'publishing and names the files: fix the part’s branch and answer «One more round» to the ' +
      'round cap question — the check merges again. If a part’s branch changes after a green ' +
      'integration (say, a fix for a reviewer), its MR update waits for a new integration; a red ' +
      'one stops publishing with the reason. «Stop the unit» closes the parts.',
    leadXl: 'XL — child tasks',
    leadXlText:
      'After the split is approved, the parts become child tasks. The parent waits for them; a ' +
      'part that depends on another starts after it. If a child is refused or fails, the parent ' +
      'ends not green and names which one and why.',

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
      'A decision carries a class label («Check», «Next action», «Permission»; the lead adds ' +
      '«Task intake» and «Task class») and an outcome headline. Click «details»: the core’s reasons are there verbatim, in English, exactly as ' +
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
      '09-lead':
        'Leading settings: scope, the Balanced profile — 4 sessions at once, Details and Learning reset',
      '10-items': 'The Several items source: two items, As a group — a task per item',
      '11-group-estimate':
        'A group estimate: the group and its tasks with feed links, leading — profile, class, sessions, slot wait',
      '12-group-launch':
        'Launching a group: Confirm the group cards, a task waiting for the class answer, Launch the group',
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
    'lead-pipeline':
      'The lead: recon, intake, task class and shape, units within the slots, review, integration and publishing',
  },
};
