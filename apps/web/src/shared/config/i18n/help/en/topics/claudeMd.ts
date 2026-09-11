import type { claudeMdRu } from '../../ru/topics/claudeMd';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const claudeMdEn: typeof claudeMdRu = {
  topic: {
    title: 'CLAUDE.md',
    summary: 'The same rules file, but whole and as it is: preamble, order, formatting',
    lead:
      'The “Rules” section parses CLAUDE.md into cards, and that is enough while ' +
      'the file consists of rules. But it also holds what does not fit a card: an ' +
      'introductory preamble, your own headings, the order of sections, blank ' +
      'lines and links. Here the file is open as plain text — exactly as Claude ' +
      'Code reads it.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why you would open the whole file and what this section is not. ' +
      'Then two diagrams and two paths in screenshots: editing the file with a ' +
      'change landing on disk underneath you, and the levels of instructions — ' +
      'where else rules live and which one wins. At the end — what goes to disk, ' +
      'the limits and how to undo every action.',

    whyWhole: 'The whole file is visible',
    whyWholeText:
      'A list of cards shows rules but not the file. The preamble, arbitrary ' +
      'sections and whatever sits between them are visible only here.',
    whyRaw: 'The text is saved as is',
    whyRawText:
      'The panel writes exactly what is in the field: no reassembling of headings, ' +
      'no reordering of sections. The formatting you built by hand stays yours.',
    whyFast: 'A quick edit without a form',
    whyFastText:
      'Changing one word in the middle of a rule, fixing a typo or swapping two ' +
      'paragraphs is easier right in the text than through a card form.',

    diffTitle: 'What this is NOT',
    diffCaption:
      'One file, several sections around it. Four neighbours this section gets ' +
      'confused with most often.',
    diffRules: 'Not the “Rules” section',
    diffRulesText:
      'There you get a card per rule: a toggle, groups, the assistant, a link to ' +
      'one rule. Here there is one field for the whole file, and the text goes to ' +
      'disk as is. Take this section when the structure of the file matters, not ' +
      'one rule.',
    diffProject: 'Not a project file',
    diffProjectText:
      'This is the personal ~/.claude/CLAUDE.md. A project has its own CLAUDE.md ' +
      'in the repository root and its own .claude directory — both live in ' +
      '“Projects”, on the “Rules” and “From the project” tabs.',
    diffPreview: 'Not a markdown editor',
    diffPreviewText:
      'It is a plain text field: no preview, no highlighting, no folding. The ' +
      'markup is checked not by the panel but by whoever reads the file — Claude Code.',
    diffHistory: 'Not a version history',
    diffHistoryText:
      'What accumulates is not a history of edits but copies of the whole file made ' +
      'before each write. A rollback in “Settings” returns that whole file, not one ' +
      'paragraph.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams about what no screen state shows: which instruction files the ' +
        'agent reads, and what the panel does with your text when it writes.',
      pathTextTitle: 'The same in words',
      pathTextText:
        'An open page remembers the version from disk as the reconciled one. While ' +
        'the field matches it, any new version simply replaces the text in the field. ' +
        'If the field holds your own edit and the file changes outside, the panel ' +
        'leaves the field alone and shows a divergence card. Saving puts a copy into ' +
        'agentdeck/backups/ and rewrites the file in full: the panel cannot merge ' +
        'two versions and does not try.',

      fileTitle: 'Editing the file: from reading to divergence',
      fileCaption:
        'The path people come here for. The last frame is the one non-obvious thing ' +
        'about the section, and it was shot with a real divergence: while an unsaved ' +
        'edit sat in the field, the file was rewritten from outside.',
      uEditor: 'The whole file',
      uEditorText:
        'The “# Личные правила” preamble, then the rule sections in the order they ' +
        'sit in the file. At the bottom, the counter: “Символов: 717” — that much ' +
        'goes into the context of every session.',
      uUnsaved: 'An unsaved edit',
      uUnsavedText:
        'A fifth rule was typed in — the counter reads “803 · есть несохранённые ' +
        'правки”, while the sidebar still shows 4 for Rules: on disk the file is ' +
        'still the old one. “Discard changes” returns the field to the loaded text.',
      uConflict: 'The file changed on disk',
      uConflictText:
        'While the edit sat in the field, the file was rewritten outside — and the ' +
        'panel said so itself, without a page reload: the rule counter became 5 and a ' +
        '“the file changed on disk…” card appeared with a “Load from disk” button. ' +
        'Your text is intact; “Save” will overwrite the new version with it.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config directory ' +
        'and a made-up project: not a single line of your ~/.claude is in them. The ' +
        'divergence in the last frame was not staged — the file really was rewritten ' +
        'from the outside while the page was open.',
    },

    layers: {
      title: 'Where else instructions live',
      caption:
        'The most common question about rules is “I wrote it and the agent ignores ' +
        'it”. Almost always it is not the rule failing but another level: a project ' +
        'has its own CLAUDE.md and its own .claude directory, and Claude Code reads ' +
        'them together with the personal file.',
      lProjects: 'The project registry',
      lProjectsText:
        'The “Projects” section keeps a list of directories, each with its own ' +
        'configuration. It opens when you pick a project in the list on the left.',
      lFile: 'The project’s CLAUDE.md',
      lFileText:
        'The “Rules” tab of a project card holds the same kind of whole-file view, ' +
        'but for the project: “CLAUDE.md in the project root as Claude reads it in ' +
        'this project”, with its own character counter below. This level has no ' +
        'cards, toggles or groups.',
      lLocal: 'The project’s own .claude directory',
      lLocalText:
        'The “From the project” tab is marked read-only: the skills, hooks and rules ' +
        'in .claude belong to the project’s git. The panel lists them and reveals the ' +
        'text on demand, but never edits or switches them off.',

      orderTitle: 'Which rule wins',
      orderCaption:
        'The short answer: none. That is not an omission in the panel but how it ' +
        'works — which is why an exception has to be written out in words.',
      orderNoRank: 'There is no seniority between levels',
      orderNoRankText:
        'The panel does not rank the files, cuts nothing out of them and does not ' +
        'decide whose text is stronger: the text of every level goes into the session. ' +
        'Two wordings that disagree are resolved by the agent reading them as text.',
      orderCan: 'What the project level can do',
      orderCanText:
        'Add its own text and state the exception outright: “in this project, unlike ' +
        'the personal rule…”. That is how a personal rule is overridden: by wording, ' +
        'not by a mechanism.',
      orderCant: 'What it cannot do',
      orderCantText:
        'Switch a personal rule off. The toggle and the “Отключённые правила” service ' +
        'section exist only in the personal file, and project text cannot reach them; ' +
        'nor is there a way to keep the personal file out of the session — it is read ' +
        'in full.',
      orderMarks: 'The panel’s marks are not a level of instructions',
      orderMarksText:
        'What is switched off and which groups hold what, the panel keeps in its own ' +
        'state.json. Claude Code never reads that file: it decides one thing only — ' +
        'how the panel assembles the personal CLAUDE.md on the next write.',
      orderWhen: 'When an edit arrives',
      orderWhenText:
        'At the start of the next session — at any level. An open conversation will ' +
        'not see the new revision, neither in the terminal nor in the panel’s chat; in ' +
        'the chat it takes a new conversation or “Restart session” in the header menu.',
    },

    canSeeAll: 'Read the whole global CLAUDE.md, preamble and service sections included',
    canEditAnything: 'Edit any part of the file, including what the “Rules” section never shows',
    canOrder: 'Reorder sections and set your own order of rules',
    canRevert: 'Discard unsaved changes and return to what is on disk',
    canFixParse:
      'Repair the file by hand if manual edits made outside the panel broke how it parses',
    canFollow:
      'See an edit made outside the panel: a clean field picks the new version up by itself, and on top of an unfinished edit the panel shows the divergence and a “Load from disk” button',

    cantProject: 'Open a specific project’s CLAUDE.md — only the global one from ~/.claude is here',
    cantPreview: 'Get a markdown preview or syntax highlighting: this is a plain text field',
    cantToggle:
      'Switch a single rule off with a toggle or build a group out of rules — that is the “Rules” section',
    cantHistory:
      'See an edit history right here: copies go to backups, and the rollback lives in “Settings”',
    cantMerge:
      'Merge your edit with what was written outside: on a divergence you pick one of the versions whole',

    storageFile: 'File',
    storageFormat: 'Format',
    storageFormatValue: 'ordinary markdown; rules are “## ПРАВИЛО: …” sections',
    storageReader: 'Who reads it',
    storageReaderValue: 'Claude Code itself at session start, in full',
    storageWatch: 'Watching the file',
    storageWatchValue:
      'the watcher brings the new version immediately, with no page reload — whether the neighbouring section wrote it or Claude Code itself',
    storageWrite: 'Writing',
    storageWriteValue:
      'the file is written beside and renamed into place — an interrupted write leaves no half file',
    storageBackup: 'Copy before the write',

    limitsTitle: 'Limits of the section',
    limitsCaption: 'The numbers and conditions people trip over most often.',
    limitLevel: 'Level',
    limitLevelValue:
      'only the active provider’s ~/.claude/CLAUDE.md. Project files live in “Projects”',
    limitSave: 'What the save sends',
    limitSaveValue:
      'the whole text of the field: the file is replaced, not appended to. On a divergence the last save wins',
    limitConflict: 'Divergence',
    limitConflictValue:
      'the panel shows a card and waits; it cannot merge versions — “Load from disk” replaces the field and loses your edit',
    limitBackups: 'Copies of the file',
    limitBackupsValue:
      'while “Back up before writing” is on in Settings (it is on by default) — a copy before every write, even for a one-character change; ten are kept, and the depth is changed there too (1 to 100). With the toggle off nothing is copied at all',
    limitReach: 'When it reaches Claude',
    limitReachValue:
      'at the start of the next session; an open conversation will not see the new revision',

    undoTitle: 'How to undo',
    undoCaption: 'Action by action: what exactly comes back, and where to go for it.',
    undoRevert: 'The edit is not saved yet',
    undoRevertText:
      'The “Discard changes” button next to “Save” returns the field to what is on disk.',
    undoConflict: 'You want the version from disk',
    undoConflictText:
      'The “Load from disk” button in the divergence card replaces the field with the new version of the file — your unsaved edit is lost with it.',
    undoBackup: 'You saved and changed your mind',
    undoBackupText:
      'A backup rollback in “Settings”: the whole file of that moment returns, not one paragraph.',
    undoDisabled: 'You erased the service section',
    undoDisabledText:
      'Only a backup rollback brings the text of switched-off rules back: the toggles in “Rules” take it from exactly there.',

    notesTitle: 'Details people trip over',
    noteRestartTitle: 'Changes reach Claude only after a restart',
    noteRestartText:
      'The file is written at once, but a session reads it once, at start. Check an ' +
      'edit in a new conversation, otherwise it looks like the rule does not work.',
    noteDisabledTitle: 'The “Отключённые правила (AgentDeck)” section is not junk',
    noteDisabledText:
      'The panel puts the text of rules switched off with a toggle there: they must ' +
      'not stay in the main body of the file or Claude would follow them. Erase that ' +
      'section by hand and the text of the switched-off rules is gone — the toggle ' +
      'will not bring it back.',
    noteConflictTitle: 'The field and the file diverge silently in one direction only',
    noteConflictText:
      'While the field holds no edits of yours, the panel simply takes the new version ' +
      'from disk. The moment an edit exists, replacing stops and the divergence card ' +
      'appears: replacing silently would lose your work, saving silently would ' +
      'overwrite someone else’s.',
    noteBackupTitle: 'A copy is made on every save',
    noteBackupText:
      'Even if you changed one character. Copies live in ~/.claude/agentdeck/backups/ ' +
      'and are rolled back from “Settings” — that is the safety net for editing by hand.',
    noteHeadingTitle: 'Only “## ПРАВИЛО: …” makes a section a rule',
    noteHeadingText:
      'The word ПРАВИЛО in any case, the colon required. “## Язык общения”, ' +
      '“### ПРАВИЛО: …” and “## ПРАВИЛО without a colon” are ordinary text: the panel ' +
      'leaves them alone and makes no cards out of them. That is also where “0 rules” ' +
      'in a non-empty file comes from; for a subheading inside a rule use the third ' +
      'level, “### ”.',
    noteProviderTitle: 'Other providers — three different models of instructions',
    noteProviderText:
      'The section is universal, but different CLIs are built differently, and the ' +
      'panel shows the model that actually exists. ONE FILE: Claude (CLAUDE.md), Codex, ' +
      'OpenCode and Kimi Code (AGENTS.md), Gemini (GEMINI.md), Qwen Code (QWEN.md), ' +
      'Goose (.goosehints) — everything above is about them. ' +
      'A LIST OF LINKS: Aider has no single instructions file, ' +
      'context files are listed by the read option in .aider.conf.yml, and the section ' +
      'edits exactly that list (add, remove, reorder); the contents of a listed file ' +
      'can be opened separately — if it already exists. A DIRECTORY OF RULES: Cursor ' +
      'keeps rules in ~/.cursor/rules (and <project>/.cursor/rules), where every .mdc ' +
      'file is a separate rule: frontmatter on top with a description, file globs and ' +
      'an “always attach” flag, markdown below. There the section becomes a directory ' +
      'manager: list, create, edit, delete; subdirectories are supported, while a plain ' +
      '.md is not read by Cursor — the panel shows such files separately and leaves ' +
      'them alone. Details are in the “Providers” document.',
  },

  shots: {
    file: {
      '01-editor': 'The whole file: preamble, rule sections and the “Символов: 717” counter',
      '02-unsaved':
        'A fifth rule typed into the field: “803 · есть несохранённые правки”, the sidebar still shows 4',
      '03-conflict':
        'The file was rewritten outside: the edit in the field is intact, the divergence card and “Load from disk” on top',
    },
    layers: {
      '01-projects':
        'The project registry: “Проектов: 1”, configuration opens by picking it in the list',
      '02-project-file':
        'The project’s CLAUDE.md on the “Rules” tab: the whole text, no cards and no toggles here',
      '03-project-local':
        'The “From the project” tab: skills, hooks and rules of the .claude directory — marked read-only',
    },
  },

  diagrams: {
    'instruction-layers':
      'Three levels of instructions and what the panel does with each: the personal one it edits as cards, the project one as text, the project’s own files it only shows. There is no seniority between them — the text of all of them goes into the session.',
    'save-and-conflict':
      'The reconciled version, an edit in the field, an edit from outside: when the panel silently takes disk, when it shows a divergence, and what happens on the write.',
  },
};
