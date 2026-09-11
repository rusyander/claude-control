import type { skillsRu } from '../../ru/topics/skills';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const skillsEn: typeof skillsRu = {
  topic: {
    title: 'Skills',
    summary: 'Instructions that switch on for a task instead of applying all the time',
    lead:
      'A skill is a folder with an instruction that Claude pulls in not always, ' +
      'but when the task matches its description. A rule applies in every ' +
      'conversation and takes up context; a skill sits aside and its text is ' +
      'loaded only when it is needed. That makes skills the right place for long ' +
      'multi-step processes that would never fit into a rule.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why the section exists and what it is not. Then two diagrams of the ' +
      'mechanism and two paths in screenshots: the first skill from scratch and ' +
      'working with a set you already have. At the end — what goes to disk, the ' +
      'fields, the limits and how to undo every action.',

    whyOnDemand: 'Switched on for the task',
    whyOnDemandText:
      'Claude reads the descriptions of all skills and takes the one that fits the ' +
      "request. Twenty detailed instructions do not get in each other's way, " +
      'because only one is in play at a time.',
    whyProcess: 'It holds a whole process',
    whyProcessText:
      'A skill can spell out the order of work step by step and carry examples, ' +
      'file templates and configs — it is a folder, not a single field.',
    whyPortable: 'It moves as a whole',
    whyPortableText:
      'A skill is an ordinary directory with markdown inside. You can copy it to ' +
      'another machine, put it in a repository, or attach it as a link to a folder ' +
      'elsewhere.',

    diffTitle: 'What this is NOT',
    diffCaption:
      'Half the questions about skills are really questions of "is this here or in ' +
      'another section". Four neighbours skills get confused with most often.',
    diffRules: 'They are not rules',
    diffRulesText:
      'A rule from CLAUDE.md is read in full at the start of every session and ' +
      'applies in any conversation. A skill sits aside: only its description goes ' +
      'into context up front, and the text follows once the task matches.',
    diffCommands: 'This is not the Commands section',
    diffCommandsText:
      'Every skill shows up in the palette as /name, and Commands lists it next to ' +
      'the built-in and plugin ones. But a skill is edited here only: that section ' +
      'just reads.',
    diffPlugins: "These are not a plugin's skills",
    diffPluginsText:
      'A plugin brings its own skills, called with a prefix — /plugin-name:skill. ' +
      'They belong to the plugin author, live in its installation directory and are ' +
      'not shown here.',
    diffProject: 'These are not project skills',
    diffProjectText:
      'The section manages the personal ~/.claude/skills/, which applies in any ' +
      "directory. A particular project's skills live in its .claude/skills/ and are " +
      'edited in the Projects section.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams answer what no screen state shows: what exactly Claude reads ' +
        'from a skill and when, and what the toggle does to the folder.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The panel writes a folder into skills/ → at session start Claude Code walks ' +
        'that directory alone and takes the name/description header out of every ' +
        'SKILL.md → once a task matches a description, the skill body is pulled in → ' +
        'nested files are read only when SKILL.md links to them. Switching off means ' +
        'moving the folder into the neighbouring skills-disabled/: the files are ' +
        'intact, but Claude no longer sees them.',

      firstTitle: 'The first skill: from an empty section to a folder with modules',
      firstCaption:
        'A path you walk once and never think about again. Every step was shot on a ' +
        'live panel with a throwaway config directory — the folders in the frames ' +
        'are real, and the edits go into them.',
      fEmpty: 'The empty section states what the panel looks for',
      fEmptyText:
        'The "No skills yet" placeholder names the condition: there is not a single ' +
        'folder with a SKILL.md inside skills/. A folder put there by hand shows up ' +
        'on its own — the list is read from disk. The sidebar shows 0 next to Skills.',
      fForm: 'Name and description are the two required fields',
      fFormText:
        'A hyphenated Latin name becomes the folder name. The description is the key ' +
        'field: Claude decides from it whether to pull the skill in at all, so it ' +
        'names the situation and the words people will arrive with ("Use WHEN…").',
      fTemplate: 'A body template fills in "Instructions"',
      fTemplateText:
        'Five SKILL.md templates: a blank scaffold, a tool skill with steps, a rule ' +
        "instruction, a check/checklist and a cleanup of the agent's working files. " +
        '"Check / checklist" is selected — the Instructions field filled itself with ' +
        'the sections "When to use", "Checklist" and "If something does not add up".',
      fStructure: 'The folder is created, the window stays',
      fStructureText:
        'Saving does not close the form: below the body a "File structure" tree ' +
        'appears — for now with a single SKILL.md. Next to it is the structure ' +
        'assistant, which creates and extends files whole and deletes nothing.',
      fCard: 'The skill in the list',
      fCardText:
        'The section counter is now 1, and the row shows the folder size (610 B) and ' +
        'the description. Four icons on the right: sandbox, edit, delete and the toggle.',
      fBuilder: 'The builder: structure is chosen before creation',
      fBuilderText:
        'The second tab of the form offers three structure presets and names the ' +
        'files of each: a single SKILL.md; SKILL.md plus references/rules.md and ' +
        'references/examples.md; and the same plus config/README.md and ' +
        'templates/README.md. The button below reads "Create and build the structure".',

      livingTitle: 'A set you already have: search, files, switching off, editing',
      livingCaption:
        'The second way into the section — not "how do I start" but "why does it ' +
        'behave like that". Frames 3 and 5 are the same file tree from two sides: in ' +
        'the list row and in the edit form.',
      lList: 'The list of skills',
      lListText:
        'Four folders, each with a size: 697 B, 300 B, 375 B and 1.0 KB. ' +
        'db-migrations is marked "Disabled" — it sits in skills-disabled/, yet has ' +
        'dropped out of neither the list nor the counter (4). release-notes shows ' +
        '"2 files": it is a folder with modules.',
      lSearch: 'Search covers descriptions too',
      lSearchText:
        'The query "миграции" matched no name and no description — and the page says ' +
        'exactly that, naming the query. A missed search does not pose as an empty ' +
        'section: the sidebar counter stays at 4.',
      lFiles: 'The file counter expands into a tree',
      lFilesText:
        'release-notes has examples.md and format.md inside references/. The files ' +
        'are edited right here, but Claude does not walk the folder by itself: ' +
        'without a link from SKILL.md it will not read them.',
      lOff: 'Switching off means moving the folder',
      lOffText:
        'The toggle on perf-audit is off, a "Disabled" mark appeared and the toast ' +
        'says "Updated". The folder moved into skills-disabled/ whole: the skill is ' +
        'gone from the palette but not from the list or the counter (still 4).',
      lEdit: 'Editing an existing skill',
      lEditText:
        'The window title names the skill: "Edit: release-notes". The folder name is ' +
        'not editable in the form — there is a separate "Rename" button for that, ' +
        "which also carries the panel's marks over. The file tree here is the same " +
        'one as in the list.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config directory ' +
        'and invented skills: not a single folder from your ~/.claude is in them. ' +
        'They are re-shot with node tools/help-shots/config-panel.mjs.',
    },

    canCreate: 'Create a skill as one file, from a SKILL.md template, or as a folder with modules',
    canRename: 'Rename a skill: the panel moves the folder and the group marks',
    canTree: "Edit any of the skill's files right in the card, as a tree",
    canAssistant: 'Ask the assistant to build the structure from a description of the task',
    canSearch: 'Search by skill name and description',
    canToggle: 'Switch a skill off without deleting it from disk',
    canRestore: 'Restore a deleted skill from a backup with one button',
    canSandbox: 'Check with a sandbox run whether the description actually fires',
    canLink:
      'Keep a skill elsewhere: a symlink or junction inside skills/ is read by the ' +
      'panel as an ordinary folder',

    cantAutoRead:
      'Expect Claude to read the nested files on its own — it takes them only when ' +
      'SKILL.md links to them',
    cantGuarantee:
      'Know in advance whether a skill will be pulled in: the model decides from the ' +
      'description, and only a run proves it',
    cantVersions: 'Keep versions and an edit history inside the panel',
    cantProject:
      "Edit a project's skills: the section manages the personal ~/.claude/skills/, " +
      'project ones live in the Projects section',
    cantPlugin:
      "Edit a plugin's skills — they belong to its author and an update overwrites any edit",

    storageFolder: 'The skill folder',
    storageMain: 'The main file',
    storageMainValue: 'SKILL.md with a YAML header of name and description',
    storageDisabled: 'Disabled ones',
    storageOff: 'What Claude reads',
    storageOffValue: 'the skills/ directory only — nothing else exists for it',
    storageMarks: "The panel's marks",
    storageMarksValue:
      "group membership lives in the panel's own state.json; whether a skill is enabled is " +
      'not stored there but decided by which of the two folders holds the directory',
    storageBackup: 'Backups',

    descriptionTitle: 'The description is the most important field',
    descriptionCaption:
      'It, and it alone, decides whether the skill is pulled in. The body has no ' +
      'say in that decision: it has not been read yet.',
    descGood: 'A description that works',
    descGoodText:
      'It names the situation and the words the user arrives with: "Use WHEN the ' +
      'user asks to write e2e tests, to cover a flow with Playwright".',
    descBad: 'A description that will not fire',
    descBadText:
      '"Helps with tests" gives nothing to latch onto. The model cannot tell this ' +
      'skill from three neighbouring ones and pulls in none of them.',
    descTip: 'Checking it on the spot',
    descTipText:
      'Run the skill in the sandbox: the panel builds a provoking task out of the ' +
      'description itself and shows whether the skill took it on.',

    templatesTitle: 'Structure presets',
    templatesCaption:
      'Chosen at creation time in builder mode and unfolded right after the skill ' +
      'appears on disk. The files of each are spelled out in the form.',
    tplMinimal: 'A simple skill',
    tplMinimalText: 'One SKILL.md. Right when the instruction fits on a page.',
    tplRefs: 'A skill with modules',
    tplRefsText:
      'SKILL.md plus references/rules.md and references/examples.md. The shape large ' +
      'skills take: the entry point stays short and the detail loads on demand.',
    tplFull: 'A skill with configs and templates',
    tplFullText:
      'Modules by topic plus config/ and templates/ — for ready files the skill ' +
      'drops into a project.',
    templatesNote:
      'A preset never overwrites what is already written: a file with content is ' +
      'skipped, and only the missing ones are created.',

    fieldsTitle: 'Fields of a skill',
    fieldsCaption: 'Names match the skillDraftSchema schema: that is how a field is found in code.',
    fieldName:
      'A hyphenated Latin name. It is also the folder name and the identifier. Locked once the ' +
      'skill exists.',
    fieldDescription:
      "When to use the skill: the situation and the user's words. The model decides " +
      'from this field whether to pull the skill in.',
    fieldBody:
      'Instructions in markdown: what to do step by step, what not to do, how to check the result.',
    fieldFiles:
      "The skill's nested files: examples, configs, templates. Edited as a tree in the card. " +
      'Deleting a file or folder in the tree asks for confirmation by typing the name: ' +
      'a folder goes with everything inside it.',
    fieldGroups: 'Groups the skill belongs to.',

    assistantTitle: 'Two assistants',
    assistantCaption:
      'One fills in the form fields, the other builds the files. They are different ' +
      'things and worth keeping apart.',
    assistantForm: 'The form assistant',
    assistantFormText:
      'Fills in the name, description and skill text from your account of the task. ' +
      'The result is visible before saving, and the dialogue can go on with ' +
      'clarifications.',
    assistantStructure: 'The structure assistant',
    assistantStructureText:
      'It returns not fields but a list of files with content and lays them out in ' +
      'the skill folder. Existing files are updated, new ones added, nothing is ' +
      'deleted on its own. It works step by step: the structure can be refined in ' +
      'the same dialogue.',
    assistantNote:
      "The structure assistant sees the skill's current tree and edits it " +
      'sensibly, but large files are shown to it truncated — a very long file may ' +
      'not be understood in full.',

    limitsTitle: 'The limits of the section',
    limitsCaption:
      'The numbers and conditions people trip over most. Everything listed here is ' +
      'visible in the frames above.',
    limitLevel: 'Level',
    limitLevelValue:
      "~/.claude/skills/ only. Project skills live in the project's .claude/skills/ and are " +
      "edited in the Projects section; a plugin's skills live in its installation directory",
    limitReach: 'When it reaches Claude',
    limitReachValue:
      'from the start of the next session. An open conversation will not see a new skill — ' +
      'neither in the terminal nor in the panel chat',
    limitWhatCounts: 'What counts as a skill',
    limitWhatCountsValue:
      'a folder inside skills/ (or skills-disabled/) that contains a SKILL.md. A folder ' +
      'without one never reaches the list; a symlink or junction to a folder counts as a folder',
    limitName: 'The name',
    limitNameValue:
      'the folder name and the identifier at once. A Cyrillic name is transliterated into a ' +
      'slug, a name with no letters or digits is rejected, and a slug already taken means a ' +
      'refusal at creation rather than a write over it',
    limitOff: 'Switching off',
    limitOffValue:
      'moving the folder into the neighbouring skills-disabled/. Editing a disabled skill goes ' +
      'there too — no second, enabled copy appears',
    limitBackups: 'Backups',
    limitBackupsValue:
      'before a deletion and before an overwrite the folder is copied into ' +
      'agentdeck/backups — as long as "Back up before writing" is on in Settings',

    notesTitle: 'Things people trip over',
    noteNestedTitle: 'Nested files are read only through a link',
    noteNestedText:
      'Claude Code does not walk the skill folder by itself. If nothing in SKILL.md ' +
      'links to references/rules.md, the file is never read — it is dead weight.',
    noteNameTitle: 'The name changes only through the Rename button',
    noteNameText:
      'A skill name is the directory name and the identifier. In the form of an ' +
      'existing skill the field is locked: editing it there would create a second ' +
      'folder rather than rename the first. Renaming has its own button on the card: ' +
      'the panel moves the folder and rewrites the references to the skill in groups ' +
      'and marks.',
    noteDeleteTitle: 'Deleting wipes the whole folder, but with a backup',
    noteDeleteText:
      'Every nested file goes at once. Before that the folder is copied whole into ' +
      'agentdeck/backups — as with rules and hooks. It can be brought back with ' +
      'the Restore button in the backup list on the settings page. No copy is made if ' +
      'backups before writing are switched off in the settings. To disable a skill ' +
      'temporarily, use the toggle — it deletes nothing.',
    noteDescTitle: 'When a skill is not pulled in, it is almost always the description',
    noteDescText:
      'If the instruction is good and Claude still does not take it, the thing to ' +
      'rewrite is not the body but the description: that is what the decision is made on.',
    noteProviderTitle: 'Other providers have their own skills',
    noteProviderText:
      'Everything described here is about the Claude skills section (a folder with ' +
      'SKILL.md, enabling by moving in and out of skills-disabled, groups, templates). ' +
      'With the OpenCode provider the section opens a different screen: its CLI keeps ' +
      'skills in ~/.config/opencode/skills/<name>/SKILL.md (and <project>/.opencode/skills/ ' +
      'in a project). The concept is the same, but the panel edits only the two required ' +
      'header fields — name and description; license, compatibility, metadata and any ' +
      'foreign fields are preserved and shown read-only. The name must match the folder ' +
      'name and follow the rules (lowercase Latin letters, digits and single hyphens, ' +
      '1–64 characters). Worth knowing: OpenCode also loads skills from ~/.claude/skills ' +
      'and ~/.agents/skills, so your Claude skills already work there — the panel says so ' +
      'and writes nothing into those directories. Qwen Code and Kimi Code get the same ' +
      'screen, only the directories change: ~/.qwen/skills/ and <project>/.qwen/skills/ for ' +
      'Qwen, ~/.kimi-code/skills/ and <project>/.kimi-code/skills/ for Kimi — which, like ' +
      'OpenCode, also picks up the shared ~/.agents/skills, and the panel does not write ' +
      "there either. One difference: Kimi's documentation caps description at 240 " +
      'characters, and the panel checks exactly that limit.',

    undoTitle: 'How to undo',
    undoCaption: 'One action at a time: what exactly comes back, and where to go for it.',
    undoToggle: 'You switched off the wrong one',
    undoToggleText:
      'Put the toggle back — the folder moves from skills-disabled/ back into skills/ with ' +
      'everything inside it.',
    undoEdit: 'An edit in the form is not saved yet',
    undoEditText:
      'Close the window with Cancel: until the save button is pressed, SKILL.md does not change.',
    undoFile: 'You deleted a file inside a skill',
    undoFileText:
      'The tree asks for confirmation by typing the name, but no copy of the single file is ' +
      'kept: the only way back is rolling the whole folder out of a backup.',
    undoDelete: 'You deleted a skill',
    undoDeleteText:
      'The whole folder sits in agentdeck/backups. The Restore button in the backup list ' +
      'on the settings page unfolds it back into skills/.',
    undoRename: 'You renamed it wrong',
    undoRenameText:
      'Rename it back with the same button: the panel carries the group marks over again. Links ' +
      'of the form /skills?id=old-name come back to life, and a copy of the former folder stays ' +
      'in backups.',
  },

  shots: {
    first: {
      '01-empty': 'An empty section: the panel looks for folders with SKILL.md, the menu shows 0',
      '02-form': 'The name becomes the folder name; the description decides whether Claude uses it',
      '03-template': 'The "Check / checklist" template filled the Instructions field itself',
      '04-structure': 'After saving the window stays: the file tree and the structure assistant',
      '05-card': 'The skill in the list: 610 B, and the section counter is now 1',
      '06-builder': 'The builder: three structure presets, each with its files listed',
    },
    living: {
      '01-list':
        'Four skills with sizes; db-migrations is marked "Disabled" yet stays in the counter',
      '02-search': 'The search for "миграции" found nothing — and the page says exactly that',
      '03-files':
        'The "2 files" counter expanded into a tree: references/examples.md and references/format.md',
      '04-off':
        'The toggle is off: a "Disabled" mark, the folder moved to skills-disabled/, counter still 4',
      '05-edit':
        'Editing an existing skill: the folder name is locked, the file tree is right there',
    },
  },

  diagrams: {
    'skill-pickup':
      "What Claude reads from a skill and when: every skill's header at session start, the body only after a match, nested files only through a link from SKILL.md.",
    'skill-on-disk':
      'Two folders and one state: the toggle moves the directory between skills/ and skills-disabled/, renaming moves the folder and the marks, deleting makes a copy first.',
  },
};
