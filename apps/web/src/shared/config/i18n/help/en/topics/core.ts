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
      'A sidebar entry. The section opens on the task board (section «Task board» below); the ' +
      '«Board / List» switch in the header leads to the list — whether a task is running now, its ' +
      'state and a link to its timeline. The header buttons lead to the launch screen and to ' +
      'scenarios; on the board «Import items» sits beside them.',
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
    leadCross: 'A second review on another CLI',
    leadCrossText:
      'Only Maximum quality: after the first review a second reviewer on another allowed CLI ' +
      'looks at the unit. It cannot approve — only its findings and refutations count: a finding ' +
      'sends the unit to a fix, and its agreement never lifts a finding of the first reviewer. ' +
      'There is no second review if no other allowed CLI is left (the contour narrowing ' +
      'included), if you pinned the first reviewer’s CLI, or if the first review ran no session: ' +
      'the reason «cross-review: …» stands in the «Unverified» part of the final report. ' +
      'Balanced and Economy never run it.',
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
      'not send a second command. An open question also arrives as a notification in Telegram, ' +
      'and on the phone only when it blocks (no default action), one push per question. An answer in the panel timeline or on the phone is signed with the phone ' +
      'key. With «Answer the core from Telegram» on (help «Integrations») the question reaches the ' +
      'bot with buttons, and the core takes the answer from there as an answer from Telegram; with ' +
      'it off — as text with a link to the task.',
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
    askKindLogin: 'login lost',
    askKindLoginText:
      'The route’s CLI logged out mid-step. «I logged in again — continue» after logging in to ' +
      'that CLI, «Stop the step» to drop it; when other usable routes exist, moves to another ' +
      'model or CLI follow below. The step never changes its route by itself. Only Claude ' +
      'recognises a lost login so far; the other CLIs never raise this question.',
    askKindExhausted: 'budget used up',
    askKindExhaustedText:
      'The route has used up its paid budget. Top up the account and clear the mark with the ' +
      'clear-exhausted command, move a started task to another model or CLI with a click if any ' +
      'exist, or stop the step.',
    askKindTrackerWrite: 'ticket write',
    askKindTrackerWriteText:
      'The MR of a tracker task is open and the source has «Reply in the ticket» on. «Allow the ' +
      'comment» writes one line with the MR link into the ticket, «Do not write» writes nothing. ' +
      'The approval is taken only from the panel or the phone; Telegram does not show that button.',

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

    boardTitle: 'Task board',
    boardCaption:
      'Every core task on one screen, in columns by stage. An entry waits in «Inbox» and «Queue»; ' +
      'the core starts the head of the queue by itself once the board limits allow it. From then ' +
      'on the task journal moves the stage, not hands.',
    boardColumns: 'Columns and limits',
    boardColumnsText:
      'Left to right: «Inbox», «Queue», «Triage», «Work», «Review», «Check», «Ready for MR», «MR ' +
      'open», «Merged / closed» and «Waiting for you» — cards that need a human. A card shows its ' +
      'source (manual, chat, tracker, forge, tests, Telegram), the number of questions, «units: 1 ' +
      'of 3», «group» and «driven by a human». Above the columns are the limits: «In work: 2 of ' +
      '2», «Started today», «Default stop», and the filters «Waiting for you · 2» and «By group». ' +
      'Closed tasks are folded behind «Show closed». The core re-reads an open MR from the forge ' +
      'by itself: a merged or closed one moves to «Merged / closed» within one sweep, about 30 ' +
      'seconds; if the forge does not answer, the card stays where it was.',
    boardEntry: 'An entry in «Inbox»',
    boardEntryText:
      'A click on a card opens its window: stage, state, stop, source, scenario. Until the task is ' +
      'started the entry has «Card moves»: from «Inbox» — «To queue» or «Reject», in «Queue» — ' +
      '«Up» (place before its neighbour), a rejected one — «Restore». A started task has no ' +
      'moves: the core moves the stage. The «Scenario» picker of an entry changes which scenario ' +
      'it launches with, until the task has started. A core refusal shows under the picker in the ' +
      'panel language, its original text in the hover hint. Moves work the same way: a move the ' +
      'core did not accept is one line in the panel language under «Card moves» (which move and ' +
      'why), the core’s original text in the hover hint, with no general pop-up notice beside it. ' +
      'If another page moved the card meanwhile (rejected it, or it started as a task), the ' +
      'window neither closes nor jumps to the task: it stays on the card as it was at the moment ' +
      'of the move, marked «The card changed on the board while the move was on its way», with ' +
      'the refusal line and no move buttons. Close the window and the board shows where the card ' +
      'is now.',
    boardTask: 'The window of a running task',
    boardTaskText:
      'Progress by unit, agents, token and turn spend, the MR and «Open in full» — the task ' +
      'timeline. Below are «Manual intervention» and «Where to stop»: at the plan, at the MR or to ' +
      'the end; the stop point cannot change after the MR. What waits for you is answered right ' +
      'in the window: blocking questions as the same answer cards as on the timeline, a window ' +
      'wait as move options, a unit takeover with its button. An entry not started yet has no ' +
      'journal: its spend, agents and unit progress read «no data».',
    boardLimits: 'Limits — the board section of the core config',
    boardLimitsText:
      'The queue head starts only while fewer tasks are in work than the limit (1, 2, 4 or 6; 2 ' +
      'out of the box), the board is not paused and fewer starts happened in the local day than ' +
      'the daily limit (none out of the box); a setting can also hold new starts while any card ' +
      'waits for a human. The default stop is «at the MR». A rejected section means the defaults ' +
      'apply, with a «Defaults» strip and the reason above the board. A failed start returns the ' +
      'card to «Inbox» with the core’s reason; neither the slot nor the daily start is spent. ' +
      'When the head’s route window is held, nobody starts: the queue is an order and the next ' +
      'entry does not overtake the head, which shows the reason.',

    inboxTitle: 'Inbox from the tracker',
    inboxCaption:
      'The core polls its sources — Jira and GitLab — by itself and puts new tickets into the ' +
      'board «Inbox», one entry per ticket. You queue them, unless the source has «Queue by ' +
      'itself» on.',
    inboxRow: 'The row above the board',
    inboxRowText:
      '«Inbox from the tracker» names the number of sources, how many are off, how often the poll ' +
      'runs and how many sources queue entries by themselves. No sources — it says so: tickets ' +
      'will not reach the board by themselves. The buttons are «Sources» and «Find in the ' +
      'tracker».',
    inboxSources: 'Sources',
    inboxSourcesText:
      'A source is Jira or GitLab; GitHub is listed but cannot be picked. Jira reads tickets by ' +
      'labels, «assigned to me only» or by your own JQL — the tracker itself judges it, it never ' +
      'goes through a model. GitLab reads issues by labels or assigned to you, MRs where you are a ' +
      'reviewer, and your MRs with open threads. «Repositories» map a forge path to a local ' +
      'folder; a ticket with a bug label goes the «Bug fix» scenario. «Queue by itself» is off ' +
      'for a new source. «Reply in the ticket» is off too: when on, after the MR opens the core ' +
      'asks whether to write a line with the link into the ticket — and writes only on an answer ' +
      'from the panel or the phone. The save sends the whole settings with their digest: edited ' +
      'past the window — the reason and «Reload the settings».',
    inboxSearch: 'Find in the tracker',
    inboxSearchText:
      'A source and a query — a ticket key, words from the title or JQL; empty means the ' +
      "source's own query. Tick what was found and press «To the inbox»: the core answers how " +
      'many are new and how many were already there. A ticket lands on the board once — a repeat ' +
      'search or poll does not duplicate it. The tracker did not answer — «The source did not ' +
      'answer» with the reason; not everything shown — the «narrow the query» note.',
    inboxPreset: 'The entry scenario',
    inboxPresetText:
      'The scenario follows the ticket kind, the ticket text plays no part: an issue — «Tracker ' +
      'ticket», type Bug or a bug label — «Bug fix», an MR to review — «MR review by link», your ' +
      'MR with threads — «Reviewer replies». You can change it in the entry window until the task ' +
      'has started.',

    relatedTitle: 'Related cards',
    relatedCaption:
      'Several tickets about the same thing can go to work as one task. The core hints which ' +
      'Inbox entries are related, and you merge them — the core never merges by itself.',
    relatedChip: '1. The «related: N» badge on a tile',
    relatedChipText:
      'An Inbox entry from the tracker carries a «related: N» badge when the core found other such ' +
      'entries by the ticket facts: a shared epic or parent (or one is the parent of the other), ' +
      'an issue link in the tracker or on the forge, a path named in both tickets. A shared label, ' +
      'author or similar title is not a relation: every polled entry has the source label. The ' +
      'hover hint names the related entries.',
    relatedMerge: '2. «Merge into this card (N)» in the entry window',
    relatedMergeText:
      'The entry window has a «Related cards» section: each related entry with its reason in ' +
      'words, all checked by default. Uncheck the extra ones and press «Merge into this card (N)»: ' +
      'the checked entries fold into this one, their tickets stay on it, and everything goes to ' +
      'work as one task with all the tickets. Folded entries leave the board and never come back ' +
      'from polling. One task takes at most 16 tickets, so you can check this entry and 15 more — ' +
      'the remaining boxes are locked, and the caption under the list says what to uncheck to ' +
      'check another.',
    relatedRefused: '3. A core refusal',
    relatedRefusedText:
      'Only Inbox entries from the tracker merge: an entry that has already gone to the queue, an ' +
      'MR entry or an entry without a ticket is refused by the core. The refusal is one line in ' +
      'the panel language in the window, with the ticket key («PROJ-11 has left the Inbox — only ' +
      'Inbox entries merge»), the core’s original text in the hover hint, with no general pop-up ' +
      'notice beside it. Nothing is merged — the board stays as it was.',

    queueTitle: 'To the queue instead of launching now',
    queueCaption:
      'The launch screen can skip the estimate for now and put the task on the board: it starts ' +
      'when a slot frees up.',
    queueForm: 'The «To queue» button and «Where to stop»',
    queueFormText:
      'Under the launch form pick where the task stops: «at the plan» — it waits for your ' +
      '«Launch» after the split, «at the MR» — it opens the MR and stops, «to the end» — it keeps ' +
      'going. «To queue» puts the entry into the board’s «Queue»; below appear «The task is in the ' +
      'board queue» and «Open the board». If the board refuses the entry, the reason sits under ' +
      'the button with «To queue — retry».',
    queueStart: 'Starting from the queue',
    queueStartText:
      'Entries in «Queue» stand in order, the first starts first — within the board limits. While ' +
      'the head’s route window is closed nobody starts: the next entry never overtakes the head, ' +
      'and the head carries the reason. The start takes the same path as yours, estimate ' +
      'included; the «at the plan» stop leaves the task waiting for your «Launch».',

    takeoverTitle: 'Take over and hand back to the core',
    takeoverCaption:
      'A takeover pauses the task at a safe point and hands it to you; handing back resumes the ' +
      'interrupted step. Rework in words does not stop the task.',
    takeoverTake: '«Take over»',
    takeoverTakeText:
      'In the window of a running task. The core pauses at the nearest safe point, the work slot ' +
      'frees up and the card shows «driven by a human». The block says «Takeover is open: you are ' +
      'driving the task» and names the task copy: work in it by hand or with «Open chat» — that ' +
      'chat may edit only this copy.',
    takeoverBack: '«Hand back to the core»',
    takeoverBackText:
      'The «What was done» field goes to the next step. The takeover chat closes first, then the ' +
      'core resumes the interrupted step.',
    takeoverRework: '«Send for rework»',
    takeoverReworkText:
      'The «What to rework» text, no takeover. While the task is running, the current step gets ' +
      'the message at the next turn boundary. Once the task is done and its MR is open, a ' +
      'review-answer task opens on that MR with this text.',

    windowTitle: 'The task waits for a limit window',
    windowCaption:
      'A step hit the subscription window — the task never changes its route by itself: it waits ' +
      'for the reset and continues on the same route, and a click can move it.',
    windowCard: 'The card in «Waiting for you»',
    windowCardText:
      'The state reads «waiting for the limit window», with «Why it stands» — the core’s reason ' +
      'verbatim. The «Limit» block names the route that refused and when the window opens: «The ' +
      'task continues by itself on the same route». When the reset time is unknown the core ' +
      'rechecks the window itself.',
    windowSwitch: 'Move without waiting',
    windowSwitchText:
      '«Move to …» goes to another CLI, «Other model: …» to another model of the same CLI; only ' +
      'routes from the task’s set are offered. With none the card says so: waiting for the reset ' +
      'is the only way. The same window in chat is the «Subscription limit» card (Chat help).',

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
    board: {
      '01-board':
        'The board: limits «In work: 2 of 2» and «Started today: 4 of 10», columns from «Inbox» ' +
        'to «Waiting for you», cards of groups 00a11a and 00b22b',
      '02-entry-window':
        'An «Inbox» entry window: source «manual», stop at the plan, moves «To queue» and «Reject»',
      '03-task-window':
        'A running task window: units 1 of 3, spend, «Take over», «Send for rework» and «Where to ' +
        'stop»',
      '04-takeover-open':
        'Takeover open: the task copy, «Open chat», the «What was done» field and «Hand back to ' +
        'the core»',
      '05-window-card':
        'The task waits for a limit window: it opens at 19:30, «Move to codex» and another model',
      '06-defaults':
        'The «Defaults» strip: the board section of the core config was rejected, the reason named',
    },
    inbox: {
      '01-row':
        'The «Inbox from the tracker» row above the board: two sources, one off, the poll and buttons',
      '02-sources':
        'The «Inbox sources» window: Jira with labels and «assigned to me only», GitLab with MRs to review',
      '03-search':
        '«Find in the tracker»: three tickets of the jira source with key, kind and a pick box',
      '04-preset': 'The «Inbox» entry window: the «Scenario» picker before the task starts',
    },
    related: {
      '01-chip':
        'Inbox tiles: two tracker entries carry the «related: 1» badge, an unrelated entry does not',
      '02-merge':
        'The entry window: the «Related cards» section with the reason in words, checked by default, and «Merge into this card (1)»',
      '03-refused':
        'A core refusal in the window: one line in the panel language with the ticket key, the core’s text in the hover hint',
    },
    queue: {
      '01-queue':
        'The launch form: «Where to stop» and the result «The task is in the board queue» with ' +
        '«Open the board»',
    },
  },

  diagrams: {
    'panel-to-core':
      'From panel to core: pages, the /api/core/* proxy, the core and the panel’s recorded hops',
    'launch-to-steps':
      'From launch to steps: form, estimate, split and launch, steps, timeline and questions to you',
    'lead-pipeline':
      'The lead: recon, intake, task class and shape, units within the slots, review, integration and publishing',
    'board-flow':
      'The board: where entries come from, «Inbox» and «Queue», the head starting within the board section limits, stages by the journal, a refused start and the card window',
    'takeover-loop':
      'Manual intervention: «Take over» at a safe point, work in the copy, «Hand back to the core» with a note, and «Send for rework» without a takeover',
    'limit-window':
      'The limit window: in chat the «Subscription limit» card and the message sent again after the reset, in a task «waiting for the window» on the same route; moving only by a click',
    'inbox-flow':
      'Inbox: source poll and search, one entry per ticket, «Queue by itself», start and MR, the ticket write only on an answer from the panel or the phone',
    'related-merge':
      'Related cards: ticket facts, the core’s «related: N» hint, your pick of up to 15 entries, one task with all the tickets or the core’s refusal in words',
    'group-lanes':
      'Group lanes: a group «To queue», the group start, «By group», «Closed» with former runs, and «Import items» — a Path into a core scenario',
  },
};
