import type { compareRu } from '../../ru/topics/compare';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const compareEn: typeof compareRu = {
  topic: {
    title: 'Configuration comparison',
    summary: 'What one CLI has configured that another does not — and moving it across',
    lead:
      'This section is about TWO providers at once, so it does not depend on the one ' +
      'selected now. The left side defaults to the active CLI, the right is any other. ' +
      'The panel reads the files of both sides and shows the difference per section; ' +
      'opening the page changes nothing. Moving is narrower than comparing: everything ' +
      'is shown, but only MCP servers and the text of the global instructions can cross.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: which sections are compared, why the comparison is by meaning ' +
      'rather than by file text, and what never crosses. Then two paths in screenshots, ' +
      'split by the cost of a mistake: “look” changes nothing, “move” writes into another ' +
      'CLI’s file and therefore goes through a preview. After the screenshots: what the ' +
      'section is not, what it reads and writes, limits and refusals, how to read a row, ' +
      'and the fine print.',

    whyMemory: 'Otherwise this is kept in your head',
    whyMemoryText:
      'Finding out which MCP servers Claude has and Codex lacks used to mean opening the ' +
      'sections one by one and comparing by eye. Here both sides are on one screen.',
    whyMeaning: 'Compared by meaning, not by text',
    whyMeaningText:
      'The same server is written differently in TOML and in JSON. The panel compares ' +
      'parsed values rather than file lines — otherwise everything would come out ' +
      '“different”.',
    whyMove: 'Moving happens where the difference is visible',
    whyMoveText:
      'Tick the entries and press the button for the direction you want. Copying by hand ' +
      'between formats is the easiest way to get a quote wrong and lose a server.',

    mapTitle: 'What is compared and what crosses',
    mapCaption:
      'Four sections are compared, two can cross. The diagram shows where that border ' +
      'runs and why it runs there.',
    pathTextTitle: 'The same in words',
    pathTextText:
      'Each side is read by its own readers, and the path of the file the values came ' +
      'from stands above the column heading. Four sections are compared: MCP servers, ' +
      'environment variables, permissions and global instructions. Differences are ' +
      'computed per key, and values are compared by meaning — a normalised parse, not ' +
      'file lines. Variables that look like keys and tokens are shown masked and checked ' +
      'for presence only. Exactly two sections can cross: MCP servers, which have a ' +
      'cross-vendor model and real write adapters, and the text of the global ' +
      'instructions, which is an ordinary file. Variables never cross (the panel does not ' +
      'write secrets into someone else’s configuration), and neither do permissions (the ' +
      'CLIs have different approval models, and a translation would be guesswork). Every ' +
      'move goes through a preview on a temporary copy of the receiving file, and only ' +
      'the confirmation changes the real one — a single file, always on the receiving ' +
      'side.',

    guide: {
      lookTitle: 'Path 1. Look: how the sides differ',
      lookCaption:
        'Reading. Nothing on disk changes, the move buttons wait for a selection. The ' +
        'question of this path is where the difference is and what it is.',
      lookMcp: 'Pick the sides and the server difference is there',
      lookMcpText:
        'Above each column stands the file the values came from. A row carries one of ' +
        'the states: same, left only, right only, differs. Under the blocked rows is the ' +
        'reason such an entry cannot cross — visible before any click.',
      lookEnv: 'Variables: presence is checked, not the value',
      lookEnvText:
        'The section is compared but never crosses, and the heading says so plainly. ' +
        'Values that look like keys and tokens are shown masked: the panel checks that a ' +
        'variable exists on both sides without showing or comparing the secret itself.',
      lookInstructions: 'Permissions stand side by side, instructions compare by text',
      lookInstructionsText:
        'Permissions carry the badge “different models”: key names may coincide while ' +
        'the meaning does not, so they are shown side by side and never cross. For the ' +
        'instructions the file contents are compared, not the names: CLI file names ' +
        'always differ, and that difference is no news.',

      moveTitle: 'Path 2. Move: a write into another CLI’s file',
      moveCaption:
        'A different cost of a mistake: the panel writes into a file kept by hand until ' +
        'now. That is why the write is always the second step — after the diff of the ' +
        'target file.',
      moveBlocked: 'What cannot cross is visible before the click',
      moveBlockedText:
        'A disabled server and the sse transport have no checkbox at all, with the reason ' +
        'written on the line below. This is not a selection error: such entries stay out ' +
        'of the move even if everything else is ticked.',
      moveSelected: 'Tick an entry and the side’s button wakes up',
      moveSelectedText:
        'There are two buttons, one per direction, and every movable section has its ' +
        'own. While nothing is ticked both are dimmed: “everything” cannot be moved by ' +
        'accident.',
      movePreview: 'The preview shows the real diff of the receiving file',
      movePreviewText:
        'The header names the file to be rewritten and counts the lines. The diff is ' +
        'computed on a temporary copy by the real write adapters, so it also shows the ' +
        'format’s side effects: rewriting a whole file can touch lines you never ' +
        'intended. “Cancel” writes nothing.',
      moveApplied: 'After the write the row reads as the same',
      moveAppliedText:
        'A toast names the number of entries moved and the comparison is recomputed: the ' +
        'entry now exists on both sides. Exactly one file changed — the receiving one.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours comparison is confused with most often.',
    notColumn: 'What is not here',
    notMeaningColumn: 'How it actually works',
    notSync: 'Synchronisation',
    notSyncText:
      'Nothing crosses by itself or on a schedule: every move is ticked entries, a ' +
      'direction button and a confirmation.',
    notFileDiff: 'A file diff',
    notFileDiffText:
      'Parsed values are compared, not lines. A line diff appears exactly once — in the ' +
      'write preview, and only for the receiving file.',
    notSwitch: 'Switching the active CLI',
    notSwitchText:
      'The section is about two sides at once and does not depend on the active provider. ' +
      'The active CLI is chosen in the settings.',
    notProject: 'Project settings',
    notProjectText:
      'User-level files are compared. Project configurations live in the “Projects” ' + 'section.',
    notHistory: 'A log of moves',
    notHistoryText:
      'No history accumulates here. What the panel actually wrote is visible in “Change ' +
      'history” — for Claude’s files with a diff, and for another CLI’s files too.',

    readTitle: 'How to read a row',
    readCaption: 'The label on the right says what is wrong with the entry — or that all is well.',
    readColumn: 'Row label',
    readMeaningColumn: 'What it means',
    readSame: 'same',
    readSameText: 'The entry exists on both sides and the values match in meaning.',
    readDiffers: 'differs',
    readDiffersText:
      'One name, different parameters: another command, another address, other variables. ' +
      'The row is marked with a stripe on the left.',
    readOnly: 'left only / right only',
    readOnlyText: 'The other side has no such entry at all — a candidate for the move.',
    readSecret: 'secret values',
    readSecretText:
      'Variables that look like keys and tokens are shown masked and checked for presence ' +
      'only. The panel neither shows nor compares a secret’s value.',
    readBlocked: 'a row with no checkbox',
    readBlockedText:
      'The entry is blocked from moving, with the reason written underneath: a disabled ' +
      'server, the sse transport, or a section that never crosses.',

    storageReads: 'What it reads',
    storageReadsValue:
      'the files of both chosen sides — the path of each is written above its column, ' +
      'right on the page',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing until the confirmation. After “Write” — exactly one file, on the receiving ' +
      'side: an MCP server is added, the instructions text is replaced whole',
    storageNever: 'What it never writes',
    storageNeverValue:
      'environment variables and permissions — in neither direction; secret values never ' +
      'reach someone else’s configuration',
    storageBackup: 'Backup',
    storageBackupValue:
      'taken before the write when backups are enabled in the settings; the edit is then ' +
      'visible in the change history',
    storageClaude: 'When Claude sees it',
    storageClaudeValue:
      'at the next session start of the CLI whose file was written: configurations are ' +
      'read on launch',

    canCompare: 'Compare MCP servers, variables, permissions and global instructions',
    canMcp: 'Move MCP servers in both directions, Claude included',
    canInstructions: 'Copy the global instructions text (CLAUDE.md → AGENTS.md and back)',
    canPreview: 'See the real diff of the receiving file before the write',
    canSwap: 'Swap the sides with one button and compare any two CLIs, not only the active one',

    cantEnv:
      'Move environment variables: they hold keys, and the panel does not write secrets ' +
      'into someone else’s configuration',
    cantPermissions:
      'Move permissions: the CLIs have different approval models, and a translation would ' +
      'be guesswork',
    cantDisabled: 'Move disabled servers or the sse transport, which other CLIs do not have',
    cantMerge:
      'Merge the instructions of two sides: the move replaces the receiving text whole ' +
      'rather than appending',

    limitsTitle: 'Limits and refusals',
    limitsCaption:
      'The panel refuses in advance and out loud: the reason is written under the row ' +
      'before you even aim at the button.',
    limitsColumn: 'What is on screen',
    limitsMeaningColumn: 'Why, and what to do',
    limitDisabled: '“The server is disabled — only enabled ones cross”',
    limitDisabledText:
      'A disabled server does not cross: the receiving side would get an entry you do not ' +
      'even use. Enable it in the MCP servers section and try again.',
    limitSse: '“The sse transport: other CLIs do not have it”',
    limitSseText:
      'There is nowhere to move it: no other CLI has that transport. stdio and http can ' +
      'cross; sse stays with Claude alone.',
    limitEnv: 'Environment variables do not cross',
    limitEnvText:
      'The section is compared but has no move button at all. Variables most often hold ' +
      'keys and tokens, and the panel does not write secrets into someone else’s ' +
      'configuration. Carry the value over by hand if you really need it.',
    limitPerm: 'Permissions do not cross',
    limitPermText:
      'The CLIs have different approval models, there is no shared vocabulary, and ' +
      'translating one mode into another would be guesswork. Permissions are shown side ' +
      'by side with the “different models” badge — configure the receiving side yourself.',
    limitUnsupported: '“The panel does not maintain … for this CLI”',
    limitUnsupportedText:
      'The section is not supported on the chosen side — its global instructions, say, ' +
      'are not a single file. The row explains that in place; there is nothing to move ' +
      'and nowhere to move it.',
    limitSame: '“The source and the receiver are the same”',
    limitSameText:
      'Both sides are one and the same CLI. Choose another in the second list; the swap ' +
      'button sits between them.',
    limitSkipped: 'Fewer entries moved than were ticked',
    limitSkippedText:
      'Skips are never silent: the panel names every entry and its reason — the source no ' +
      'longer has it, or the entry is blocked. The rest still crosses instead of the whole ' +
      'move rolling back.',

    noteTitle: 'Moving instructions overwrites the file whole',
    noteText:
      'This is a copy, not a merge: the source text replaces the receiving one. The diff ' +
      'before the write says so plainly — read it if the receiving file had something of ' +
      'its own.',
    noteActiveTitle: 'The section does not depend on the active CLI',
    noteActiveText:
      'The left side defaults to the active provider, but both sides are chosen freely: ' +
      'two CLIs neither of which is active right now can be compared.',
    notePreviewTitle: 'The preview runs on a temporary copy, with the real adapters',
    notePreviewText:
      'The diff is not “approximate”: it is a write into a copy of the file by the very ' +
      'code that will write for real. That is why it also shows the format’s side ' +
      'effects — rebuilt quotes or reordered keys.',
    noteRestartTitle: 'What was written is seen at the next launch',
    noteRestartText:
      'The file changes at once, but a CLI reads its configuration when a session starts. ' +
      'An agent already running keeps working by the old one.',
  },

  shots: {
    look: {
      '01-mcp':
        'Claude Code on the left (C:\\Users\\user\\.claude.json), Codex on the right (config.toml): catalog-mock “same”, design-mocks “left only”, docs-index “right only”, legacy-prices marked “The server is disabled” and tracker-bridge marked “The sse transport”',
      '02-env':
        'The variables section: CODEX_API_TOKEN right only as dem••••00, GIT_BASH_PATH left only, MAX_THINKING_TOKENS “same” — and under every secret row “The value is secret — only its presence was checked”',
      '03-instructions':
        'Permissions with the “different models” badge — nine rows, not a single checkbox — and “Global instructions”: CLAUDE.md · 933 B against AGENTS.md · 226 B, labelled “differs”',
    },
    move: {
      '01-blocked':
        'The same screen before any choice: legacy-prices and tracker-bridge have no checkboxes at all, the reason is written on the line below, and both move buttons are dimmed',
      '02-selected':
        'design-mocks is ticked — “Move to Codex (OpenAI)” has become active while “Move to Claude Code” stays dimmed',
      '03-preview':
        'The “What will be written” window for C:\\Users\\user\\.codex\\config.toml: “Changes: +5 / −2”, [mcp_servers.design-mocks] with its url is added, and two args lines are rewritten by the format',
      '04-applied':
        'After “Write”: design-mocks now reads “same” on both sides, with the toast “Entries moved: 1”',
    },
  },

  diagrams: {
    'what-crosses-and-what-does-not':
      'Two sides, four compared sections and the border of the move: what crosses, what never does, and why the write always follows a preview',
  },
};
