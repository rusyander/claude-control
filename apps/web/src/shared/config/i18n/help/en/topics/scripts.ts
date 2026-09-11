import type { scriptsRu } from '../../ru/topics/scripts';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const scriptsEn: typeof scriptsRu = {
  topic: {
    title: 'Scripts',
    summary: 'The code hooks run: written, edited and tested here',
    lead:
      'A hook answers “when to run”; a script answers “what exactly to do”. These ' +
      'are ordinary files in the hooks/ directory: you can write them yourself, or ' +
      'let the panel create one for you from a hook template. This section shows ' +
      'the whole directory, including files not wired to any hook.',

    guideTitle: 'What this page contains',
    guideText:
      'First, how the section differs from Hooks and where the files live. Then a ' +
      'diagram of how the "in use" mark is worked out, and two paths in ' +
      'screenshots: going through a directory that already exists, and creating a ' +
      'new file. At the end — the stdin/stdout contract, the scaffolds, the limits ' +
      'and how to undo.',

    whyEdit: 'Edited in one place',
    whyEditText:
      'No hunting for the file on disk and opening an editor: the code is visible ' +
      'and editable right in the card, next to the file tree.',
    whyOrphans: 'Unused files are visible',
    whyOrphansText:
      'The panel matches files against hooks — together with whatever the bound ' +
      'scripts import — and marks the ones nothing points to. Such a file was either ' +
      'never wired up or is left over from a deleted hook.',
    whyTest: 'Tested without the model',
    whyTestText:
      'A script can be run against a prepared event straight from its card: you see ' +
      'the output, the exit code and the decision. Fast, and it uses none of your limit.',

    diffTitle: 'This is not the Hooks section',
    diffCaption:
      'Two sections about the same action, from different sides. The "when" and ' +
      'the "what" are split on purpose: one file can serve several hooks.',
    diffHook: '"Hooks" is an entry in settings.json',
    diffHookText:
      'The event, the tool filter, the command and the timeout. There is no code ' +
      'there: it says when and what to run.',
    diffScript: '"Scripts" is the files in hooks/',
    diffScriptText:
      'Here you get the code and the whole directory, including whatever is bound ' +
      'to no hook. The section is available with every provider: these are files, ' +
      'not a foreign config.',
    diffBoth: 'You need both',
    diffBothText:
      'A file created here never runs on its own — it still has to be bound to an ' +
      'event. And the other way round: deleting a hook does not touch the file.',

    guide: {
      mapTitle: 'How "in use" is worked out',
      mapCaption:
        'The diagram covers the one non-obvious thing in the section: why a shared ' +
        'module named in no hook still counts as bound, and why tests stay out of ' +
        'the forgotten-files count.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The panel takes the commands of every hook from settings.json and ' +
        'settings.local.json, finds file names in them, and then follows the ' +
        'relative import and require chains of those files — transitively, not one ' +
        'step. Everything reached is "In use". Tests and fixtures are marked ' +
        'separately: the tests/ folder and names like *.test.* or *.spec.*; they ' +
        'stay out of the forgotten count. The rest is "Unbound": either the binding ' +
        'was forgotten or the file is left over from a deleted hook.',

      filesTitle: 'The directory is not empty: going through it',
      filesCaption:
        'The first way in. Seven files, and every row tells you the same things: ' +
        'whether it is bound, how big it is and what is inside.',
      fList: 'The whole directory as one list',
      fListText:
        'The subtitle states exactly what people open the section for: 7 files, 1 ' +
        'not bound to any event. The row marks are "In use", "Unbound" on ' +
        'notify.ps1 and "Test" on guards.test.mjs, which stays out of the forgotten ' +
        'count. Sizes run from 269 to 632 bytes: a working guard is a few dozen lines.',
      fContent: 'The code is visible without a form',
      fContentText:
        'A row expands into its content right in the list. shared/input.mjs sits in ' +
        'a nested folder and is named in no hook, yet is marked "In use": bound ' +
        'scripts import it.',
      fSearch: 'A missed search shows the query',
      fSearchText:
        'Nothing found — the panel says what was searched for rather than "there ' +
        'are no scripts". Search covers both the file name and its content.',
      fDelete: 'Deletion states the consequence',
      fDeleteText:
        'The dialog does not ask "are you sure?"; it says what will happen: ' +
        'destructive-guard.mjs is called by a hook, the hook will stay in ' +
        'settings.json and will silently stop working, because the file will not be found.',

      newTitle: 'The file does not exist yet: creating it',
      newCaption:
        'The second way in. There is no need to start from an empty file — the ' +
        'scaffolds already read the event and carry hints.',
      nForm: 'Four ready scaffolds',
      nFormText:
        'Blank scaffold, command guard, format on save, session briefing. Scaffolds ' +
        'are offered when creating only, so the button never wipes code you have ' +
        'already written.',
      nTemplate: 'The scaffold filled in code and name',
      nTemplateText:
        'The command guard wrote the event parsing and a JSON decision. The file ' +
        'name is only filled into an empty field: one typed by hand — here ' +
        'no-secrets.mjs — is left alone.',
      nBulk: 'Several at once',
      nBulkText:
        'The second mode: checkboxes instead of a form. Two scaffolds are ticked ' +
        'and the button states the number — "Create selected (2)". The panel creates ' +
        'them one by one, showing progress.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config ' +
        'directory: the panel reads a real hooks/ folder and writes into it, and ' +
        'works out the bindings from a real settings.json. They are re-shot with ' +
        'node tools/help-shots/config-panel.mjs.',
    },

    canWrite: 'Write and edit code right in the panel',
    canTemplate: 'Start from a ready scaffold instead of an empty file',
    canBulkTemplates: 'Create several scaffolds at once by ticking the ones you want',
    canProbe: 'Run a script against nine prepared events',
    canSee: 'See the whole hooks/ directory, including unwired files and scripts in nested folders',
    canExpand: 'Expand a file’s contents right in the list, without opening the form',
    canRename: 'Rename a file while editing — unlike skills, the name is not locked here',
    canLang:
      'Use more than Node: .mjs, .cjs, .js, .ts, .sh, .ps1 and .py are listed — and .ts, ' +
      '.mts and .cts run through node --experimental-strip-types, with no separate ' +
      'TypeScript build',
    canAssistant: 'Ask the assistant to write the body of the script from a description',

    cantSchedule: 'Run a script on a schedule — only on a Claude Code event',
    cantInstall: 'Install dependencies: a script gets whatever is already on the system',
    cantDebug: 'Step through it in a debugger — only output and the exit code are visible',
    cantAuto:
      'Expect a file created here to work on its own: it still has to be bound to an ' +
      'event by a hook',
    cantOutside:
      'Keep a script outside hooks/: the section shows one directory, a file elsewhere never ' +
      'reaches the list',

    storageFolder: 'Directory',
    storageExt: 'What counts as a script',
    storageExtValue: 'files with the extensions .mjs .cjs .js .ts .mts .cts .sh .ps1 .py',
    storageDesc: 'Where the description comes from',
    storageDescValue: 'the first comment lines at the top of the file',
    storageUsed: 'How “in use” is decided',
    storageUsedValue:
      'the file name appears in a hook command — or the file is imported by a bound ' +
      'script (following relative import/require chains)',

    flowTitle: 'How a script receives an event and answers',
    flowCaption:
      'A script talks to Claude Code through streams: the event arrives on input, the ' +
      'answer leaves on output. Nothing extra to wire up.',
    flowStdin: 'stdin',
    flowStdinCaption: 'the event as JSON',
    flowCode: 'Your code',
    flowCodeCaption: 'decides what to do',
    flowStdout: 'stdout',
    flowStdoutCaption: 'text or a JSON decision',
    flowExit: 'Exit code',
    flowExitCaption: '0 to pass, 2 to refuse',

    answersTitle: 'Two ways to answer',
    answersCaption:
      'Both work. The second one came later and is easier: the decision and the reason ' +
      'travel together, without leaning on a numeric code.',
    answerExit: 'With an exit code',
    answerExitText:
      'Exit with code 2 and write the reason to stderr. The action stops, and Claude ' +
      'sees the reason.',
    answerJson: 'With a JSON answer',
    answerJsonText:
      'Print a decision to stdout with a permissionDecision field — deny, ask or ' +
      'allow — plus an explanation. The exit code then does not matter.',

    templatesTitle: 'Ready scaffolds',
    templatesCaption:
      'Four of them, available when creating only, so a template button never wipes ' +
      'code you have written. The file name is filled in only if the field is still empty.',
    bulkTitle: 'Several at once',
    bulkText:
      'The second creation mode: tick several scaffolds and the panel creates them ' +
      'one by one, showing progress. Handy when you want the whole set rather than ' +
      'one file at a time.',
    tplBlank: 'Blank scaffold',
    tplBlankText:
      'Reads the event from stdin, with comments pointing at where things are and room ' +
      'for your logic.',
    tplGuard: 'Command guard',
    tplGuardText:
      'Checks the command against dangerous patterns and answers with a JSON decision ' +
      'asking for confirmation. No exit code needed — the decision travels in the answer.',
    tplFormat: 'Format on save',
    tplFormatText:
      'Takes the path of the changed file, filters by extension and runs prettier over ' +
      'it. A formatter error is deliberately swallowed so it never gets in the way.',
    tplBrief: 'Session briefing',
    tplBriefText:
      'Reads nothing and immediately prints extra context for the session — a reminder ' +
      'to check the working notes.',

    fieldsTitle: 'Fields of a script',
    fieldsCaption:
      'There are only two fields: the rest is file information the panel shows itself.',
    fieldName:
      'The file name with its extension, for example notify.mjs. The extension decides ' +
      'what runs the file.',
    fieldContent: 'The full script code.',
    fieldPath: 'The path on disk. Read only.',
    fieldIsUsed:
      'Whether the file is bound to at least one hook: straight from a hook command or ' +
      'through an import from a bound script (relative import/require, transitively).',
    fieldSize: 'File size and last modification date. Shown in the list row.',

    limitsTitle: 'The limits of the section',
    limitsCaption:
      'The numbers and conditions people trip over most. Everything listed here is ' +
      'visible in the frames above.',
    limitFolder: 'Where files are looked for',
    limitFolderValue:
      'only hooks/ inside the config directory, nested folders included; a file kept ' +
      'elsewhere never reaches the list',
    limitExt: 'Which extensions are shown',
    limitExtValue:
      'nine: .mjs .cjs .js .ts .mts .cts .sh .ps1 .py. A file with any other extension is ' +
      'not shown at all',
    limitTests: 'Tests',
    limitTestsValue:
      'the tests/ folder and *.test.* / *.spec.* names are marked separately and stay out of ' +
      'the unbound count',
    limitUsage: 'How deep binding goes',
    limitUsageValue:
      'relative import and require, transitively; a package from node_modules or a path built ' +
      'in a variable cannot be traced',
    limitRun: 'Running',
    limitRunValue:
      'nine prepared events plus your own JSON; the interpreter must be on the system — if it ' +
      'is missing the panel says so plainly',
    limitApply: 'When it takes effect',
    limitApplyValue:
      'immediately: the code is read from disk when it runs. A session restart is only needed ' +
      'when the hooks themselves change',

    recipesTitle: 'Writing your own script',
    recipe1: 'Create a file from a scaffold',
    recipe1Text:
      'Take the blank scaffold — it already reads the event and points at where the ' +
      'command and the file path live.',
    recipe2: 'Write the logic and save',
    recipe2Text: 'The decision can come back as exit code 2 or as a JSON answer — both work.',
    recipe3: 'Run it against the prepared events',
    recipe3Text:
      'The sandbox button on the card. It has a safe command, a destructive one and a ' +
      'token write — you see what the script caught.',
    recipe4: 'Bind it to an event',
    recipe4Text:
      'A file does not run by itself. Create a hook pointing at this script, or it stays ' +
      'marked “unbound”.',

    undoTitle: 'How to undo',
    undoCaption:
      'A script is an ordinary file, and the ways back are the ordinary ones. The ' +
      'order below runs from the gentlest option to the bluntest.',
    undoUnbind: 'Unbind instead of deleting',
    undoUnbindText:
      'If the script is in the way, remove or switch off the hook in the Hooks ' +
      'section: the file stays on disk marked "unbound" and is easy to bring back.',
    undoEdit: 'Rewrite the code',
    undoEditText:
      'An edit takes effect on the next event — no restart needed. A sandbox run ' +
      'shows the result straight away, before the hook fires for real.',
    undoBackup: 'Take it from a backup',
    undoBackupText:
      'Before an overwrite or a deletion the panel puts a copy of the file into ' +
      'backups/. That is the only way to bring a deleted script back: the section ' +
      'has no recycle bin.',

    notesTitle: 'Things people trip over',
    noteUnusedTitle: '“Unbound” is not an error, but worth a look',
    noteUnusedText:
      'That mark goes on files no hook reaches: neither directly from its command nor ' +
      'through an import from a bound script. Usually it means a forgotten binding or a ' +
      'leftover from a deleted hook. Tests and fixtures (the tests/ folder, *.test.* ' +
      'names) are marked separately and stay out of the count.',
    noteDeleteTitle: 'Deleting a script in use breaks its hook silently',
    noteDeleteText:
      'The hook stays in the settings but has nothing to run — and no error appears. The ' +
      'panel warns separately about this kind of deletion.',
    noteInterpreterTitle: 'The extension decides what runs it',
    noteInterpreterText:
      '.mjs, .cjs and .js go through node, .ts, .mts and .cts through ' +
      'node --experimental-strip-types, .py through python, anything else through ' +
      'bash. .ps1 is the special case: powershell on Windows, pwsh on Linux and macOS ' +
      'if it is installed. The panel checks for it before running and says so plainly ' +
      'when it is missing, instead of failing with a cryptic error. Other interpreters ' +
      'may be missing too.',
    noteRestartTitle: 'Editing code needs no restart',
    noteRestartText:
      'A script is read from disk when it runs, so new code takes effect on the next ' +
      'event. A restart is only needed when the hooks themselves change.',
    noteProviderTitle: 'The section works with every provider',
    noteProviderText:
      'Scripts are the panel’s own files, not a foreign config, so the section is there ' +
      'with Codex, Gemini, Qwen Code, Cursor, OpenCode or Aider too. Claude alone keeps the ' +
      'sandbox, the “called by a hook” flag and the hook scaffolds: the other CLIs have ' +
      'no hooks, so plain standalone scripts are offered instead.',
  },

  shots: {
    files: {
      '01-list': 'Seven files in hooks/; one is bound to no event, the test is marked separately',
      '02-content': 'Content expands in the list: a shared module in a nested folder',
      '03-search': 'A missed search names the query instead of claiming there are no files',
      '04-delete': 'The dialog states the consequence: the hook stays and silently stops working',
    },
    new: {
      '01-form': 'Four scaffolds instead of an empty file — offered when creating only',
      '02-template': 'The scaffold wrote the code; a file name typed by hand is left alone',
      '03-bulk': 'Several at once: the button states how many scaffolds are ticked',
    },
  },

  diagrams: {
    'script-usage':
      'How the "in use" mark is worked out: from hook commands to file names, then along the chain of relative imports. Tests are marked separately, everything else is "unbound".',
  },
};
