import type { analyticsRu } from '../../ru/topics/analytics';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const analyticsEn: typeof analyticsRu = {
  topic: {
    title: 'Analytics',
    summary: 'Token spend and activity, counted from local transcripts',
    lead:
      'This section counts from your own files, not from Anthropic’s data: every model ' +
      'answer in a transcript carries its usage, and the panel adds them up. Hence both ' +
      'the strengths and the limits: everything that happened on this machine is ' +
      'visible, and nothing that happened on another one. The panel has no database — ' +
      'the report is rebuilt from the files on disk every time.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: how a line of a transcript becomes a number on a tile, and ' +
      'why money here is an estimate rather than a bill. Then two paths in screenshots, ' +
      'split by entrance: the “report” is opened to look back, the “live slice” to see ' +
      'whether anyone is working right now — their sources differ. After the ' +
      'screenshots: what the section is not, what it reads and writes, its limits, what ' +
      'the metrics mean, a separate block on lowered runs, and the fine print.',

    whyLocal: 'Counted from your own files',
    whyLocalText:
      'No requests are sent anywhere and no keys are needed: the source is the ' +
      'transcripts on disk. It works without a network too.',
    whyWhere: 'It shows where the spend goes',
    whyWhereText:
      'A breakdown by day, model, project, hour and tool. One glance is usually enough ' +
      'to see which project eats the most.',
    whyCache: 'It shows what the cache is worth',
    whyCacheText:
      'The share read from cache is counted separately. A high share means long ' +
      'conversations cost less than their size suggests.',

    mapTitle: 'How the numbers are produced',
    mapCaption:
      'The path from a transcript line to a tile: which files are opened at all, how one ' +
      'model answer is counted, and where the price comes from.',
    pathTextTitle: 'The same in words',
    pathTextText:
      'The panel walks the transcript directory and opens only the files changed since ' +
      'the start of the chosen period: a file older than that cannot hold fresh ' +
      'records. Each opened file is read in full, line by line, as a stream — lines are ' +
      'neither sampled nor skipped, except the unfinished last line of an active session ' +
      'that cannot be parsed. Claude Code writes one model answer as several lines, ' +
      'repeating the usage in each, so an answer is counted once, from its fullest line. ' +
      'Records outside the period are dropped, and a record with no parsable timestamp ' +
      'is counted nowhere. The day and the hour are taken in the machine’s local time, ' +
      'and the price from the tariff at the moment of the record, not today’s. A ' +
      'session’s project is the directory it was launched from. The finished report is ' +
      'cached for a minute; the list of running processes has a short cache of its own.',

    guide: {
      reportTitle: 'Path 1. The report: where the spend went',
      reportCaption:
        'A look back. The entrance is the section itself: the period on top, the ' +
        'breakdowns below, the sessions at the end. Everything shown here is counted ' +
        'from files on disk.',
      reportToday: 'Today’s day by default',
      reportTodayText:
        'These are calendar days from local midnight, not the last 24 hours: in the ' +
        'morning half of yesterday does not leak into the report. The five tiles answer ' +
        'different questions: volume, number of requests, how much the model wrote, how ' +
        'much came from cache, and what it would have cost at API rates.',
      reportMonth: 'Another period — the same tiles, different numbers',
      reportMonthText:
        'Day presets are calendar days too: “30 days” means today plus the 29 whole days ' +
        'before it. A longer period brings in the daily chart, and the model and project ' +
        'breakdowns fill up: two projects are visibly sharing the spend.',
      reportDetail: 'A click on a bar opens the details',
      reportDetailText:
        'The window holds this model’s whole spend: its share of the total, the number ' +
        'of requests, all four kinds of tokens separately, and the cost estimate. Below ' +
        'are the latest sessions of that model; the one running right now is marked.',
      reportHours: 'Hours, tools and skills are about habits, not money',
      reportHoursText:
        'The hourly chart shows when the work actually happens (in your machine’s time). ' +
        'Beside it is what the agent really uses: tools are counted from the calls in the ' +
        'transcripts, while skill statistics are taken from Claude Code’s own file rather ' +
        'than recomputed.',
      reportSessions: 'Sessions and the scan line at the bottom',
      reportSessionsText:
        'Each row is a conversation: project, git branch, models and volume. At the very ' +
        'bottom of the page it says how many files the panel walked and in how many ' +
        'milliseconds — that line is what shows the numbers came off the disk, not out of ' +
        'somebody’s database.',

      liveTitle: 'Path 2. The live slice: is anyone working right now',
      liveCaption:
        'A different entrance and a different source: not files but the machine’s process ' +
        'list. The only block on the page showing the present rather than history.',
      liveIdle: 'Empty means there are no processes',
      liveIdleText:
        'The block says exactly that: no running Claude Code processes found. There is no ' +
        'registry of agents, so the panel counts the machine’s processes — and leaves ' +
        'itself out of the list.',
      liveRunning: 'Running agents are shown with memory and PID',
      liveRunningText:
        'A counter in the header, the total memory in the expand line, and every process ' +
        'separately. Agents are recognised by their command line, not by the process ' +
        'name: a CLI installed through npm runs as node and would be invisible by name.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours analytics is confused with most often.',
    notColumn: 'What is not here',
    notMeaningColumn: 'Where it actually is',
    notBill: 'A subscription bill',
    notBillText:
      'This is tokens recomputed at API rates — a reference figure. Real charges are ' +
      'visible in the Anthropic account and will not match these numbers.',
    notLimits: 'The remaining limits',
    notLimitsText:
      'Limits live on Anthropic’s servers and never reach local files. The exact figures ' +
      'come from the /usage command inside Claude Code.',
    notChat: 'The content of conversations',
    notChatText:
      'Only the service usage data is taken from the transcripts. Reading or searching a ' +
      'conversation belongs to the chat, not here.',
    notRegistry: 'The panel’s list of agents',
    notRegistryText:
      'The “running right now” block counts operating-system processes, not the panel’s ' +
      'own runs. Those are kept in the chat and in the run registry.',
    notHistory: 'The configuration change history',
    notHistoryText:
      'Analytics is about model spend. Who changed the settings files and when is the ' +
      '“Change history” section.',

    storageSource: 'Source',
    storageSourceValue: '~/.claude/projects/**/*.jsonl — conversation transcripts',
    storageWhat: 'What is taken from a file',
    storageWhatValue:
      'the usage attached to every model answer, the tool calls and the git branch; the ' +
      'text of the messages is not read',
    storageSkills: 'Skills',
    storageSkillsValue: 'call statistics are taken from ~/.claude.json',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing from this section: transcripts are only read. There are two panel files ' +
      'nearby, and analytics keeps neither: the chat writes the log of lowered runs, and ' +
      'the contour gateway writes the spend through a contour (the “Spend through the contour” card, ' +
      'agentdeck/state.json → platformSpend); the card only reads it',
    storageCache: 'Cache',
    storageCacheValue:
      'the summary is cached for a minute (the refresh button recounts), the process list ' +
      'for ten seconds',
    storageClaude: 'When Claude sees it',
    storageClaudeValue: 'never — the section changes nothing in the configuration',

    canPeriod:
      'Switch the period: today’s day from midnight by default, plus week, month, ' +
      'quarter, all time or your own dates. In the calendar one click gives the report ' +
      'for that day, a second stretches it into a range; “Reset” returns the default',
    canDetail: 'Open the details of a model or project by clicking its bar',
    canLive: 'See the Claude Code processes actually running now and their memory',
    canTools: 'Look at which tools and skills are used most often',
    canSessions: 'Find recent conversations with their git branches and volume',
    canExport: 'Export the report as a file — CSV or JSON',

    cantLimits:
      'Learn the remaining subscription limits: they are kept on Anthropic’s servers and ' +
      'are not available locally',
    cantBill:
      'See the real bill: this is tokens recomputed at Anthropic’s list price, not a ' +
      'statement — discounts, batch pricing and account terms are not in it',
    cantOther: 'Account for work from another machine: only this machine’s transcripts count',
    cantRealtime:
      'Watch the spend in real time: the summary is rebuilt at most once a minute, and a ' +
      'transcript record appears only after the model has answered',

    limitsTitle: 'Limits and refusals',
    limitsCaption: 'Why the numbers look different from what was expected, and what to do.',
    limitsColumn: 'What happens',
    limitsMeaningColumn: 'Why, and what to do',
    limitCache: 'The numbers lag by a minute',
    limitCacheText:
      'A full walk of the transcripts costs seconds, so the finished report is held for a ' +
      'minute: switching filters must not reread a thousand files. Need them fresh — ' +
      'force a refresh of the page; editing the tariffs clears the cache by itself.',
    limitOld: 'An old conversation is missing from the period',
    limitOldText:
      'Only files changed since the start of the period are opened. A long-untouched ' +
      'conversation will not appear in a short period — take a longer one or “all time”.',
    limitSessions: 'Fewer sessions in the list than there were',
    limitSessionsText:
      'The last twenty-five conversations of the period are shown, not all of them — and ' +
      'the CSV or JSON export carries the same twenty-five. The summary numbers, however, ' +
      'are counted over every session of the period, not over the visible ones.',
    limitProject: 'A conversation is counted under the “wrong” project',
    limitProjectText:
      'The project is the directory the session was launched from: every record has its ' +
      'own working directory, and it changes with every move the agent makes. Counting ' +
      'each of them as a project would scatter one conversation into dozens of rows like ' +
      'node_modules.',
    limitLive: 'The live list is empty although an agent is running',
    limitLiveText:
      'No permission to enumerate processes, or the system answers differently — the block ' +
      'is simply empty, with no error. The start time is shown on Windows only: on other ' +
      'systems there is nowhere to take it from.',
    limitPrice: 'The cost is counted at an old price',
    limitPriceText:
      'The price list is fetched from the Anthropic site when the settings are opened, at ' +
      'most once a day; with no network the previous snapshot is used and the settings ' +
      'honestly show its date. Your own prices, entered in the settings, beat ' +
      'everything: the price list and the price published by the contour gateway alike.',
    limitDir: 'The configuration directory was switched — the numbers changed',
    limitDirText:
      'As it should be: the transcripts of the currently selected directory are counted. ' +
      'The previous spend has not gone anywhere — it is in the previous directory.',

    metricsTitle: 'What the metrics mean',
    metricTotal: 'Total tokens',
    metricTotalText:
      'The sum of four kinds: input, output, read from cache and written to cache. One ' +
      'request almost always spends several kinds at once.',
    metricCache: 'Cache share',
    metricCacheText:
      'How much of the input came from cache instead of being read anew. The higher it ' +
      'is, the cheaper long conversations are.',
    metricCost: 'Cost estimate',
    metricCostText:
      'Tokens recomputed at API rates. It is a reference figure: on a subscription no ' +
      'money is charged for these requests. The panel fetches the price list from the ' +
      'Anthropic site when the settings are opened (at most once a day) and counts at the ' +
      'price of the model version named in the transcript: Opus 4.1 is three times ' +
      'dearer than Opus 4.8. The same place shows the rates and lets you edit them by ' +
      'hand if your terms differ. Cache writes are counted at two rates: the hourly cache ' +
      'is 1.6 times dearer than the five-minute one in the price list, and in transcripts ' +
      'almost the whole write volume goes into it. Your own price is taken exactly as ' +
      'entered and multiplied by nothing. The “Spend through the contour” card stands ' +
      'apart and follows its own order: your own prices → the price the gateway ' +
      'declared in its model catalog → the price list. There is no “unknown model” ' +
      'rate there at all: tokens of a model with no price are not converted into ' +
      'money, and the model itself is named.',
    metricRequests: 'Requests and active sessions',
    metricRequestsText:
      'How many calls to the model happened during the period and how many conversations ' +
      'are going on right now. A session counts as active while its file has changed ' +
      'within the last ten minutes. Useful when the tokens are many and it is unclear ' +
      'whether that is many conversations or one long one.',
    metricOutput: 'Output tokens',
    metricOutputText:
      'A tile of its own: how much the model wrote. This part of the spend grows with long ' +
      'answers, while the input part grows with the size of the context.',
    metricHours: 'The hourly chart',
    metricHoursText:
      'The only chart about routine: which hours of the day the work happens in, in your ' +
      'machine’s time. Handy for noticing that half the spend falls on night runs.',
    metricScan: 'The scan line at the bottom',
    metricScanText:
      'How many files the panel walked and in how many milliseconds. Files are read in ' +
      'full, so this is an honest measure of the work, not an estimate.',
    metricSessions: 'Sessions',
    metricSessionsText:
      'The period’s conversations with their project, git branches and volume. Active ones ' +
      'are marked; the list holds the latest twenty-five.',

    loweredTitle: 'Lowered fan-out runs',
    loweredCaption:
      'The block appears only if there were lowerings: runs that went a step below the ' +
      'conversation’s ceiling, and how they ended. It counts not spend but the delivery ' +
      'bar — the one place in the panel showing whether a lowering was paid for with ' +
      'checks.',
    loweredWhen: 'Where the rows come from',
    loweredWhenText:
      'From two places: the “Run in several” window, where you lowered the step by hand, ' +
      'and split groups whose step the panel chose itself. A run at the ceiling never ' +
      'reaches the log — no delivery bar was added to it, so there is nothing to ask of ' +
      'it. The log keeps the last two hundred entries and lives in its own file in the ' +
      'panel’s data directory.',
    loweredRow: 'What a row says',
    loweredRowText:
      'The run’s directory, the model with its depth — already expanded into a concrete ' +
      'name rather than “sonnet” — and the outcome icon. The model named is the one the ' +
      'run actually used: the lowering to a step and the expansion of that step into a ' +
      'name both happen before the write, so the log also shows what the panel put in ' +
      'place of your choice.',
    loweredSeen: '“No checks seen” is about the panel, not about the agent',
    loweredSeenText:
      'The panel counts as checks the commands run through Bash: `pnpm test`, `npm run ' +
      'lint`, `npx tsc`, `go test`, `pytest` and their like. A check run through a wrapper ' +
      'script of its own or through an MCP server never reaches here at all, so an empty ' +
      'list means exactly “the panel did not see it”, not “the agent did not check”. The ' +
      'opposite error is possible too: a command that looks like a check counts even if ' +
      'it checked nothing.',
    loweredCrash: 'A crashed run is counted separately',
    loweredCrashText:
      'A run that never reached the end has its own icon — “the run crashed” — and does ' +
      'not fall into “no visible checks”. It ran no checks not because it ignored the bar ' +
      'but because it never got that far, and folding the two cases into one number would ' +
      'blame the agent for someone else’s fault.',
    loweredKinds: 'The cut by class of work',
    loweredKindsText:
      'Under the summary the lowerings are laid out by the classes the panel itself ' +
      'picked: how many runs, what the class cost in tokens, and how many times no checks ' +
      'were seen. A manual fan-out has no class — the step there was chosen by a human, ' +
      'and such runs gather into a “no class” row rather than hiding. These numbers are ' +
      'for you: they show which class has its step set too low. The agent that sorts ' +
      'tasks into classes is never told what a class costs — otherwise it would start ' +
      'labelling everything mechanically, “saving” where there is nothing to save.',
    loweredWhere: 'What to do about it',
    loweredWhereText:
      'A row with no checks noticed is a reason to open that conversation and look for ' +
      'yourself, not a verdict. If lowerings regularly arrive without checks, the step for ' +
      'that class of tasks is set too low: the picker is switched off in the chat menu, ' +
      'and the fan-out step is set by hand in the launch window itself.',
    loweredNote:
      'The log has been kept since the day it appeared: runs that happened earlier will ' +
      'not be in it, and an empty card on an old project means “no lowerings since then”, ' +
      'not “never any”.',

    noteLimitsTitle: 'The remaining subscription limits cannot be shown',
    noteLimitsText:
      'They live on Anthropic’s servers and never reach local files. All that is ever ' +
      'visible is the limit reset time, when one was hit right inside the chat.',
    noteCostTitle: 'The cost is an estimate, not a bill',
    noteCostText:
      'Tokens are recomputed at API rates. On a subscription none of these sums are ' +
      'charged: the figure is there to compare projects with each other.',
    noteWholeTitle: 'Files are read in full, yet one answer is counted once',
    noteWholeText:
      'A transcript is read line by line as a stream, to the end: the panel peeks at ' +
      'neither the head nor the tail. Claude Code, however, writes one model answer as ' +
      'several lines, repeating the usage in each with a growing count of what was ' +
      'written — so an answer is counted once, from its fullest line. Otherwise the ' +
      'output would be understated and everything else counted several times over.',
    noteProjectTitle: 'The project comes from the launch directory',
    noteProjectText:
      'The working directory changes with every move the agent makes inside a session, so ' +
      'the project is the one the conversation started from. One conversation is one ' +
      'project, even if the agent walked the whole disk.',
    noteLiveTitle: 'Agents are found by command line, not by process name',
    noteLiveText:
      'A CLI installed through npm runs as node — there simply is no process named claude ' +
      'in the system. While the panel searched by name, the “Live agents” block was almost ' +
      'always empty although agents were working. Now the command line is parsed and such ' +
      'runs are found. The panel excludes itself from the list, and the start time is ' +
      'shown on Windows only: on other systems there is nowhere to take it from.',
    noteScopeTitle: 'Only this machine is counted',
    noteScopeText:
      'Work from another computer or from another configuration directory will not reach ' +
      'these numbers.',
  },

  shots: {
    report: {
      '01-today':
        'The “Today” period: 1.1 million tokens in total (1,124,802), 9 requests to the model, 14.3 thousand generated, 89 % read from cache, 0.96 $ at API rates',
      '02-month':
        'The same screen over “30 days”: 53.3 million tokens, 486 requests, 86.9 % from cache, 59.72 $ — and the daily spend chart from 08-13 to 09-10 has appeared',
      '03-detail':
        'A click on the claude-opus-4-8 bar: 19.1 million tokens (35.9 % of the total volume), 173 requests, 16.3 million read from cache, 2.4 million written, an estimate of 36.57 $ — and the latest sessions of that model',
      '04-hours':
        'Activity by hour from 9:00 to 18:00, the most often called tools (Read 104, Task 96, WebFetch 95) and skill usage (release-notes 34, price-import 21, legacy-import 4)',
      '05-sessions':
        'The latest sessions with their project, git branch (main, feature/roles), models and volume; below them the card about subscription limits and the line “50 files scanned in 34 ms”',
    },
    live: {
      '01-idle': 'The “Running right now” block at zero: “No running Claude Code processes found”',
      '02-running':
        'The same block at two: “Show processes — 2, 1.1 GB”, PID 24180 at 612 MB and PID 31044 at 488 MB',
    },
  },

  diagrams: {
    'how-the-report-is-built':
      'The path from transcripts to the report: which files are opened, how one model answer is counted, where the price comes from, and how the live slice differs from history',
  },
};
