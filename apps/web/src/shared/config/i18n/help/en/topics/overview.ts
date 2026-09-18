import type { overviewRu } from '../../ru/topics/overview';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const overviewEn: typeof overviewRu = {
  topic: {
    title: 'Overview',
    summary: 'What is connected right now and where the configuration was found',
    lead:
      'The start page answers two questions: which configuration directory was found ' +
      'and what is inside it. The panel has no database of its own — every number ' +
      'here is counted from the files of that directory at the moment the page is ' +
      'opened. This is the only place that shows what is otherwise silent: a hook ' +
      'pointing at a script that does not exist, a script bound to nothing, and the ' +
      'wrong settings directory.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: where every number comes from and why it cannot disagree ' +
      'with its section. Next to it, the ladder of three rules that picks the ' +
      'configuration directory. Then two paths in screenshots: “first look” is walked ' +
      'once after installing, “the numbers are wrong” is opened on the day the ' +
      'overview shows a configuration that is not yours. After the screenshots: what ' +
      'the section is not, what it reads and writes, its limits and the fine print.',

    whyWhere: 'It shows where you are writing',
    whyWhereText:
      'The panel can work with several configuration directories. If an empty or ' +
      'foreign configuration opened, the answer is here: which path was chosen and by ' +
      'which rule.',
    whyBroken: 'It catches silent breakage',
    whyBrokenText:
      'A hook with a broken path raises no error — it simply never fires. On the ' +
      'overview that tile’s caption turns red, and that is the only signal.',
    whyEntry: 'The entrance to every section',
    whyEntryText:
      'Every tile is a link. The volume is visible at once: how many rules there are, ' +
      'how many of them are enabled, how many scripts are unused.',

    mapTitle: 'How it works',
    mapCaption:
      'Not a single number on this page is stored. The diagram shows the path from a ' +
      'file on disk to a tile — and what else is checked along the way.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'First the directory is picked: a path set by hand, then the CLAUDE_CONFIG_DIR ' +
      'variable, then ~/.claude — the first matching rule wins. The files of that ' +
      'directory are read by the same readers the sections use, which is why the ' +
      'overview and a section cannot disagree. Along the way the panel checks what is ' +
      'only visible on disk: a hook whose script is missing is marked broken, and a ' +
      'script no hook refers to is marked unbound. MCP server health is NOT probed on ' +
      'open: the result of the last connection check is taken from the panel’s own ' +
      'file. Groups come from there too, while the number of backups and the changes ' +
      'summary come from the backup directory. A watcher follows the files: an edit ' +
      'made by hand outside the panel recounts the numbers by itself, without F5.',

    sourceTitle: 'Where the configuration directory comes from',
    sourceCaption:
      'Checked in order, the first match wins. Hence the common story: the path was ' +
      'once set by hand, and it overrides the environment variable.',
    sourceTop: 'stronger',
    sourceManual: 'path set in the panel settings',
    sourceEnv: 'the CLAUDE_CONFIG_DIR environment variable',
    sourceHome: 'the usual ~/.claude directory',
    sourceNote:
      'If everything on the overview is zero, start here: most likely the wrong ' +
      'directory was found. The path is changed in the panel settings and applies at ' +
      'once.',

    guide: {
      tourTitle: 'Path 1. First look: what the panel sees at all',
      tourCaption:
        'Walked once, right after installing. The task is not to configure anything ' +
        'but to grasp the volume: how much of each thing exists and where the doors ' +
        'lead.',
      tourTiles: 'The whole screen, top to bottom',
      tourTilesText:
        'Three tiers, read in exactly that order. The directory card — where the panel ' +
        'is looking. The changes line — what moved during the week. The tiles — how ' +
        'much of each thing there is: the big number is the total, the caption below ' +
        'it says how much of that is actually in force.',
      tourSection: 'A tile is a door, not a scoreboard',
      tourSectionText:
        'A click opens the section, and the number matches the list: four rules on the ' +
        'tile, four rows in the section. They cannot diverge — the same code reads both.',
      tourQuick: 'The small links under a tile go straight to a form',
      tourQuickText:
        '“Add” opens the creation form in the right section, skipping the list. The ' +
        'rules tile has a second link straight into CLAUDE.md, the backups tile one ' +
        'into the change history.',
      tourChanges: 'The changes line leads into the history',
      tourChangesText:
        'Its number is the history feed’s entries for the last seven days, not a ' +
        'counter of its own. A click opens that same feed in full.',

      troubleTitle: 'Path 2. The numbers are wrong: is the panel even looking there',
      troubleCaption:
        'Opened on another day for another reason: the configuration on screen is not ' +
        'the one you remember. The answer is not on a tile but on the directory card ' +
        'above them.',
      troubleDir: 'All zeros — almost always the wrong directory',
      troubleDirText:
        'The badge on the card names the rule that picked the path: “set manually” ' +
        'means the path was once typed into the panel settings, and it is stronger than ' +
        'the environment variable. The yellow line below lists the files missing from ' +
        'that directory. The badge stays green: the directory is readable, the question ' +
        'is only what lies in it.',
      troubleHook: 'A red caption is the only signal of a broken hook',
      troubleHookText:
        'The directory is right, the numbers match, but the hooks tile caption turned ' +
        'red: one of the hooks in settings.json points at a script that is not on disk. ' +
        'Such a hook does not fail — it simply never fires, and nothing else reports it.',
      troubleHooks: 'The same hook in its own section',
      troubleHooksText:
        'A click on the tile opens the list where the culprit is visible: the badge ' +
        '“Script file not found” and the path the panel looked at. It is fixed right ' +
        'there — by correcting the path or creating the script.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours the overview is confused with most often.',
    notColumn: 'Neighbouring section',
    notMeaningColumn: 'What lives there instead',
    notAnalytics: 'Analytics',
    notAnalyticsText:
      'Token spend, running agents and active sessions live there. The overview knows ' +
      'nothing about conversations: it counts settings, not work.',
    notSettings: 'Settings',
    notSettingsText:
      'The directory path is only shown here. It is changed in the panel settings — ' +
      'together with backups, whole-file restore and the rotation depth.',
    notSearch: 'Search',
    notSearchText:
      'The overview answers “how many”, search answers “where exactly”. A tile will not ' +
      'help you find one rule by a word from its text.',
    notProjects: 'Projects',
    notProjectsText:
      'Only the global configuration directory is counted. A single project’s settings, ' +
      'its copies and its MCP servers live in “Projects” and never enter these tiles.',
    notHistory: 'Change history',
    notHistoryText:
      'The “Changes in 7 days” line is a counter and a link. What exactly changed, and ' +
      'how to bring one hunk back, is visible only in the history itself.',

    storageReads: 'What it reads',
    storageReadsValue:
      'CLAUDE.md, settings.json, settings.local.json, .claude.json (beside ~/.claude, or ' +
      'inside a directory that was set explicitly), skills/, hooks/',
    storageOwn: 'The panel’s own files',
    storageOwnValue:
      'agentdeck/state.json (groups, health checks), agentdeck/backups/. Before the rename the folder carried the former product name: the first start copies it here and leaves the old one as a backup',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing. The overview is the only page of the panel that merely reads: opening ' +
      'it is safe in any state of the configuration',
    storageWhen: 'When it is recounted',
    storageWhenValue:
      'on opening the page and on every change to the directory’s files — a watcher ' +
      'follows them, no reload needed',
    storageClaude: 'When Claude sees it',
    storageClaudeValue:
      'the overview changes nothing, so there is nothing for Claude to see. Edits made ' +
      'in the sections reach it at the next session start',

    canSee: 'See how many settings of each kind exist and how many of them are enabled',
    canPath: 'Check the configuration directory path and which rule picked it',
    canMissing: 'Learn which configuration files are missing',
    canBroken: 'Spot broken hooks, failed MCP servers and unused scripts',
    canBackups: 'See the number of backups and the date of the latest one',
    canChanges: 'See the “changed in 7 days” summary with a jump into the change history',
    canJump: 'Open a section or its creation form straight from a tile',

    cantEdit: 'Edit settings right here: a tile leads into a section, it does not edit in place',
    cantDeep: 'Understand why one particular setting fails: that belongs to its own section',
    cantProject: 'See a project’s configuration: only the global directory is counted',
    cantProbe:
      'Probe MCP servers: the overview shows the result of the previous check, it does ' +
      'not run a new one',

    refusalsTitle: 'What the states mean',
    refusalsCaption:
      'The overview forbids nothing — it has nothing to refuse. Yet it is the only page ' +
      'reporting four states that are invisible anywhere else.',
    refusalsColumn: 'What is on screen',
    refusalsMeaningColumn: 'What it means and what to do',
    refusalZero: 'Everything is zero',
    refusalZeroText:
      'The directory was found but it is empty, or it is not your directory. Look at the ' +
      'badge on the card: a path set by hand overrides the environment variable. It is ' +
      'changed in the panel settings and applies at once.',
    refusalMissing: '“Files not found: …”',
    refusalMissingText:
      'The listed files are not in the directory. That is not always breakage: some of ' +
      'them are created on first use, and an empty rule list only means CLAUDE.md has ' +
      'not been started yet.',
    refusalBroken: '“N hooks with a broken path”',
    refusalBrokenText:
      'settings.json holds a hook whose script is not on disk. It will silently never ' +
      'fire; it is fixed in the “Hooks” section by correcting the path or creating the ' +
      'file.',
    refusalUnused: '“N not bound to events”',
    refusalUnusedText:
      'A file lies in hooks/ but no hook refers to it. Usually a forgotten setting. ' +
      'Tests and fixtures are not counted here — they are deliberately never bound.',
    refusalMcp: '“N not responding”',
    refusalMcpText:
      'That many servers failed the LAST connection check. The overview runs no new ' +
      'check: it is started in the “MCP servers” section, where the reason is shown too.',
    refusalCrash: '“This section failed to render”',
    refusalCrashText:
      'A bug in the panel’s code, not in your data. “Try again” redraws the section ' +
      'without a reload, “Copy error” puts the text with its stack into the clipboard.',

    tilesTitle: 'What stands behind a tile',
    tilesCaption: 'The big number is the total, the caption below it is what is actually in force.',
    tileRules: 'Rules, skills, hooks',
    tileRulesText:
      'Three separate tiles. Each shows a total and how many are enabled: the gap ' +
      'between the two numbers is what lies disabled and does nothing. Hooks are counted ' +
      'from both settings.json and the personal settings.local.json.',
    tileScripts: 'Scripts',
    tileScriptsText:
      'How many files are in the directory and how many of them are bound to no hook. A ' +
      'module imported by a bound script (from lib/, say) counts as bound with it. When ' +
      'everything is bound, the caption says exactly that.',
    tileHooksBroken: 'Hooks in red',
    tileHooksBrokenText:
      'The tile caption turns red when a hook’s script is not found on disk. Such a hook ' +
      'silently never fires, and nothing else reports it.',
    tileMcp: 'MCP servers and permissions',
    tileMcpText:
      'For servers — how many exist and how many are enabled; if one failed the last ' +
      'check, the caption turns red instead. For permissions — the total number of rules ' +
      'split into allowed, ask-first and denied. “Ask first” appears only when such rules ' +
      'exist, otherwise the sum would not match the caption.',
    tileGroups: 'Groups',
    tileGroupsText:
      'How many setting bundles exist. While there are none the caption says so plainly — ' +
      'the tile does not look broken.',
    tileBackups: 'Backups',
    tileBackupsText:
      'How many copies lie in the panel’s directory and when the latest was taken. It ' +
      'leads not into a section but into the “Safety” tab of the settings, where copies ' +
      'are managed.',
    tileContour: 'Contour',
    tileContourText:
      'The last tile, and it is absent until at least one contour is set up. The number ' +
      'is how many contours are enabled; the caption is the most alarming state there is: ' +
      '“budget exhausted”, then a rejected key, then nearing the budget (“by our estimate ' +
      'N % of the budget is spent”), otherwise the state of the first enabled one. The ' +
      'first two turn the tile red. It leads to the Contour section.',
    tileChanges: 'The “Changes in 7 days” line',
    tileChangesText:
      'It stands above the tiles and is counted from the history feed: one edit of one ' +
      'file is one entry. Zero means the panel rewrote nothing during the week.',

    notesTitle: 'Fine print people trip over',
    noteZeroTitle: 'All zeros — almost always the wrong directory',
    noteZeroText:
      'Look at the directory card: it says which path is chosen and by which rule. A ' +
      'path set by hand overrides the environment variable.',
    noteLiveTitle: 'The numbers are counted live',
    noteLiveText:
      'The panel has no database: every time the page opens, the configuration files are ' +
      'read again, and a watcher follows their changes. Edits made by hand appear ' +
      'without reloading the page.',
    noteMissingTitle: '“Files not found” is not always a problem',
    noteMissingText:
      'Some configuration files are created on first use. An empty rule list only means ' +
      'CLAUDE.md has not been started yet.',
    noteHealthTitle: 'MCP server health comes from the previous check',
    noteHealthText:
      'Opening the overview does not walk the servers: that would cost seconds per ' +
      'server and break on any network. The result of the last connection check, saved ' +
      'in the panel’s file, is shown instead. A fresh answer comes from the check button ' +
      'in the “MCP servers” section.',
    noteCrashTitle: 'A section failed to render',
    noteCrashText:
      'A card with that title in place of a section is a bug in the panel’s code, not in ' +
      'your data. Navigation and the other sections keep working; “Try again” redraws the ' +
      'section without a reload, “Copy error” puts the text with its stack into the ' +
      'clipboard for a report. A single chat message does the same: a broken entry hides ' +
      'only itself, the rest of the conversation stays intact.',
    noteToastTitle: 'Notifications are never lost',
    noteToastText:
      'A toast in the bottom-right corner lives three seconds, shows at most three lines ' +
      'and closes with a cross; hovering stops the timer. Long command output is not cut ' +
      'off: clicking the card opens a window with the whole text and a “Copy text” ' +
      'button. Missed ones lie in “Notifications” at the bottom of the sidebar — with the ' +
      'same window on click.',
  },

  shots: {
    tour: {
      '01-tiles':
        'The whole overview: the directory C:/Users/user/.claude “detected automatically”, “Changes in 7 days: 5” and eight tiles — 4 rules, 3 skills, 3 hooks, 4 scripts, 4 MCP servers, 7 permissions, 0 groups, 5 backups',
      '02-section':
        'The rules tile opened its section: four rules, exactly as many as the tile showed',
      '03-quick-add':
        'The “Add” link on the skills tile opened the skill creation form, skipping the list',
      '04-changes':
        'The changes line opened the history: five entries for the week, each with its file, time and ±lines',
    },
    trouble: {
      '01-wrong-dir':
        'The directory is “set manually” — D:/backup/claude-2026-08, “Files not found: CLAUDE.md, settings.json”, and every tile is at zero',
      '02-broken-hook':
        'The same overview on its own directory: the hooks tile caption is red — “1 hooks with a broken path”, and scripts report “1 not bound to events”',
      '03-hooks':
        'The “Hooks” section: the fourth hook carries the badge “Script file not found” and the path the panel looked at',
    },
  },

  diagrams: {
    'where-numbers-come-from':
      'The path from a file in the configuration directory to a number on a tile, and the four checks along the way',
  },
};
