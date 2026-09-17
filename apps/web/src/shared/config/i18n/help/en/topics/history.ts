import type { historyRu } from '../../ru/topics/history';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const historyEn: typeof historyRu = {
  topic: {
    title: 'Change history',
    summary: 'A feed of configuration edits with a line diff over the backups',
    lead:
      'Before every write the panel puts aside a backup of the file. The feed is built ' +
      'from those copies: what changed and when, and how an edit differs from the one ' +
      'before it. The diff reads forward in time, so “+N/−M” means how many lines this ' +
      'edit added and removed. A single block can be brought back straight from here, ' +
      'leaving the rest of the file alone.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: where the copies come from, how the feed is assembled from ' +
      'them, and where the diff has its limits. Then one path in screenshots — the ' +
      'section has one entrance, the feed itself — but carried to the end: to bringing ' +
      'one block back, and to that return becoming a new entry of the feed. After the ' +
      'screenshots: what the section is not, what it reads and writes, limits and ' +
      'refusals, how to read a feed row, and the fine print.',

    whyWhat: 'You can see what changed',
    whyWhatText:
      'The feed gathers the edits of every configuration file: settings.json and its ' +
      'local twin, CLAUDE.md, ~/.claude.json (MCP servers). Project files and the files ' +
      'of other CLIs live under their own names and stay out of the user-level feed.',
    whyDiff: 'A line diff',
    whyDiffText:
      'Every edit shows the lines added and removed, not just the fact that something ' +
      'changed — and exactly which line it was.',
    whyBack: 'One block can be brought back',
    whyBackText:
      'Not the whole file but one particular change: the rest of the file stays as it ' +
      'is. A copy of the current state is taken before the write, so the return is ' +
      'reversible too.',

    mapTitle: 'Where the feed comes from',
    mapCaption:
      'Copies are put aside before every write by the panel, so the feed is a series of ' +
      'file snapshots in time, not a log of actions.',
    pathTextTitle: 'The same in words',
    pathTextText:
      'Any write by the panel into a configuration file starts with a copy: the file, ' +
      'stamped with the time, lands in the backup directory. The feed groups copies by ' +
      'target file and sorts them by time, working out what changed in each. An ordinary ' +
      'copy is compared with the previous one; the newest with the current file on disk ' +
      '(that is the last edit not yet copied, including one made by hand in an editor); ' +
      'the oldest has no predecessor and nothing to be compared with. The diff is our ' +
      'own and line-based: a very large or binary file is not parsed. Copies of another ' +
      'CLI’s files are visible with the provider’s badge, but reverting from them is ' +
      'refused — their names overlap with Claude’s. Secrets never appear in the feed: ' +
      'the secrets file and the key store are filtered out explicitly.',

    guide: {
      traceTitle: 'The path. Find an edit and bring one block back',
      traceCaption:
        'One entrance — the feed itself. But it has to be carried to the end: bringing ' +
        'a block back writes into the working configuration file and becomes a new feed ' +
        'entry of its own.',
      traceFeed: 'The feed: what, when, and against what',
      traceFeedText:
        'Every row is one copy: the file, the time and what it was compared with. ' +
        '“Against the current file” is the newest copy, that is the latest edit not yet ' +
        'copied. “First known version” is the oldest copy, which has no predecessor. ' +
        '“No changes” means a write happened while the content stayed the same.',
      traceDiff: 'The diff opens right inside the row',
      traceDiffText:
        'Removed lines in red, added ones in green, the rest of the file as context ' +
        'around them. In the newest copy’s diff (“against the current file”) every block ' +
        'of changes has its own return button: exactly that block comes back, not the ' +
        'whole edit and not the whole file. Older copies (“against the previous copy”) ' +
        'show a read-only diff — no block can be returned from it.',
      traceRevert: 'The confirmation says what exactly will happen',
      traceRevertText:
        'The dialog names the file, promises to keep the current state as a separate ' +
        'copy — and warns about the main thing: the edit takes effect after Claude Code ' +
        'is restarted, because it reads the configuration when a session starts.',
      traceAfter: 'The return becomes a feed entry itself',
      traceAfterText:
        'A new row appears on top — the very copy taken before the write — and a toast ' +
        'names it. Nothing is erased: going back to a previous state is always one more ' +
        'step forward.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours history is confused with most often.',
    notColumn: 'What is not here',
    notMeaningColumn: 'Where it actually is',
    notGit: 'A version control system',
    notGitText:
      'No branches, no commits, no merges: these are snapshots of a few settings files, ' +
      'taken by the panel before its own writes. Project code lives in git, not here.',
    notRestore: 'Restoring a whole file',
    notRestoreText:
      'One block is returned from here. Restoring the whole file to a previous copy, ' +
      'seeing the list of copies and the rotation depth — that is Settings, the safety ' +
      'tab.',
    notChat: 'Conversation history',
    notChatText:
      'The feed is about configuration files. What the agent wrote and what the model ' +
      'answered lives in the chat and in analytics.',
    notProject: 'Edits in project files',
    notProjectText:
      'User-level files are tracked. What the agent changed in a repository is shown by ' +
      'the project’s git, not by this feed.',
    notAudit: 'An action log',
    notAuditText:
      'It does not say who pressed a button: a copy speaks only of the file’s content ' +
      'before and after. An edit made by hand in an editor looks exactly like one made ' +
      'by the panel.',

    storageSource: 'Source',
    storageTracked: 'Tracked',
    storageTrackedValue:
      'settings.json, settings.local.json, CLAUDE.md, ~/.claude.json, plus the files of ' +
      'the active CLI when it is not Claude (with the provider’s badge)',
    storageSecrets: 'Always excluded',
    storageSecretsValue: '.mcp-secrets.env, provider-keys.enc, provider-keys.key',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing until a block return is pressed. The return writes into the configuration ' +
      'file itself, after taking a copy of its current state',
    storageRotation: 'How many copies are kept',
    storageRotationValue:
      'ten per file by default, configurable from 1 to 100; surplus old copies are ' +
      'removed on every new write',
    storageClaude: 'When Claude sees it',
    storageClaudeValue:
      'after a block return — at the next session start: Claude Code reads the ' +
      'configuration when it launches',

    canFeed: 'Watch the feed of edits for every configuration file',
    canDiff: 'Open the line diff of an individual edit',
    canCounts: 'See “+N/−M” — how many lines the edit added and removed',
    canRevertHunk:
      'Bring one block of changes back from the newest copy’s diff without touching the rest of the file',
    canOffline: 'Read the history even when taking new copies is switched off',

    cantSecrets: 'See the diff of .mcp-secrets.env — secrets are deliberately never diffed',
    cantWhole: 'Return a whole file: full restore lives in the Settings section',
    cantProvider: 'Revert a copy of another CLI’s file — it is view-only',
    cantBig: 'Get the diff of a very large or binary file — it is not parsed',

    limitsTitle: 'Limits and refusals',
    limitsCaption: 'What the panel answers instead of a diff or a revert — and what to do.',
    limitsColumn: 'What is on screen',
    limitsMeaningColumn: 'Why, and what to do',
    limitFirst: '“First known version”',
    limitFirstText:
      'The oldest copy has no predecessor, so there is nothing to compare it with. ' +
      'Earlier edits either happened before the panel was installed or have already been ' +
      'pushed out by rotation.',
    limitSame: '“No changes”',
    limitSameText:
      'The copy matched its neighbour: a write happened while the content stayed the ' +
      'same. Ordinary when the panel rewrites a file with the same values.',
    limitProvider: 'A copy of another CLI’s file is view-only',
    limitProviderText:
      'The revert refuses before any write and names the reason. Copy names of different ' +
      'CLIs overlap, and a mistake here would mean writing a foreign config over Claude’s ' +
      'files. The diff itself is fully visible.',
    limitBig: 'No diff is shown',
    limitBigText:
      'The file is over 512 KB or longer than 5000 lines, or it is binary. The feed stays ' +
      'cheap; block returns are unavailable for such a file too — it can only be restored ' +
      'whole, from the settings.',
    limitMissing: '“Current file not found”',
    limitMissingText:
      'The copy exists but the file itself is not on disk — it was deleted or renamed. ' +
      'There is nowhere to return the block to: restore the whole file from the settings.',
    limitRotation: 'Old edits have vanished from the feed',
    limitRotationText:
      'A limited number of copies is kept per file (ten by default), the rest are removed ' +
      'on a new write. Need deeper history — raise the rotation depth in the settings, ' +
      'remembering that more copies will sit on disk.',
    limitOff: 'New edits do not reach the feed',
    limitOffText:
      'Taking a copy before a write is switched off in the settings. Copies already taken ' +
      'are still there and still readable, but no new entries will appear until the ' +
      'setting is turned back on.',

    rowTitle: 'How to read a feed row',
    rowCaption: 'A row carries six meanings, and three of them are markers, not errors.',
    rowColumn: 'What stands in the row',
    rowMeaningColumn: 'What it means',
    rowFile: 'The file name',
    rowFileText: 'Which configuration file changed. A provider badge means another CLI’s file.',
    rowAgainst: '“Against the previous copy”',
    rowAgainstText:
      'An ordinary copy: the edit that led to it is shown. This is a view forward in ' +
      'time, so “+” is what was added right then.',
    rowCurrent: '“Against the current file”',
    rowCurrentText:
      'The newest copy is compared with what lies on disk right now. This is where the ' +
      'latest edit not yet copied shows up — including one made by hand in an editor.',
    rowCounts: '“+N/−M”',
    rowCountsText:
      'How many lines this edit added and removed. Zeros are not shown: if nothing was ' +
      'removed, only “+N” stands there.',
    rowFirst: '“First known version”',
    rowFirstText: 'The oldest copy of the file: it has no predecessor, so it never has a diff.',
    rowProvider: 'The provider badge',
    rowProviderText:
      'A copy of the active CLI’s file. The diff reads, the return button is absent — and ' +
      'that is not a failure.',

    noteSecretTitle: 'Secrets are never diffed',
    noteSecretText:
      'The .mcp-secrets.env file is not among the tracked ones — nor is the provider key ' +
      'store with its machine secret. A line diff would reveal token values right in the ' +
      'interface, so they are filtered out explicitly.',
    noteRestartTitle: 'A return takes effect after Claude Code restarts',
    noteRestartText:
      'The file on disk changes at once, but Claude Code reads the configuration when a ' +
      'session starts. A conversation already running keeps working by the old rules.',
    noteRevertTitle: 'A revert erases nothing',
    noteRevertText:
      'A copy of the current state is taken before the write and appears at the top of ' +
      'the feed immediately. Undoing the return is another step forward, not a deletion ' +
      'of the past.',
    noteWholeTitle: 'A whole file is returned in Settings',
    noteWholeText:
      'History returns a block. Full restore from a copy, the list of copies and the ' +
      'rotation depth live in the safety tab of the settings.',
    noteBigTitle: 'Large files are not parsed',
    noteBigText:
      'A file that is too large (over 512 KB or longer than 5000 lines) or binary does ' +
      'not go into a diff — the feed stays cheap and drags no rubbish into the interface.',
  },

  shots: {
    trace: {
      '01-feed':
        'A feed of five entries: CLAUDE.md “against the current file” +4 −1, CLAUDE.md “against the previous copy” +3, settings.json +2 −1, “This is the first known version — nothing to compare with”, and .claude.json “no changes”',
      '02-diff':
        'The diff of that entry opened: the removed line “Прогонять тесты.” in red, three added ones in green, each block with its own “Return this change” button',
      '03-revert':
        'The “Return only this change?” dialog: one block comes back, the current state is kept as a separate copy, and the edit takes effect after Claude Code restarts',
      '04-after':
        'After the return a new CLAUDE.md entry +1 −1 stands on top of the feed, the one below it now reads “no changes”, and the toast at the bottom names the copy taken — CLAUDE.md with a timestamp and the .bak extension',
    },
  },

  diagrams: {
    'where-the-feed-comes-from':
      'The path from a panel write to a feed row: the backup directory, edits by hand, the diff limits, the return of one block, and what history does not hold',
  },
};
