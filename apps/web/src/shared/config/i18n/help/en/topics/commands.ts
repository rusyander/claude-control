import type { commandsRu } from '../../ru/topics/commands';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const commandsEn: typeof commandsRu = {
  topic: {
    title: 'Commands',
    summary: 'Everything you call with a slash, in one list with search',
    lead:
      'A slash command is not a thing of its own on disk: the same "/" menu is ' +
      "assembled from skills, command files, plugins and the CLI's own built-in " +
      'commands. The palette shows only a name, so there is usually nowhere to ' +
      'find out what a command does, whose it is and where to edit it. This ' +
      'section shows the whole set at once: source, description, owner, file path ' +
      'and a button that takes you to the section where the command lives.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why the section exists and what it is not. Then a diagram of how ' +
      'the list is assembled and two paths in screenshots: finding a command ' +
      'whose name you forgot, and working out why a command vanished from the ' +
      'palette. At the end — the sources, the limits and what to do when a ' +
      'command is nowhere to be seen.',

    whyOne: 'One list instead of four places',
    whyOneText:
      'Skills, command files, plugins and built-in commands live in different ' +
      'places and are called the same way. Here they are one list, sorted by name.',
    whyWhose: 'The origin is visible',
    whyWhoseText:
      'Every row carries a source badge and an owner: a skill, a file in ' +
      'commands/, a plugin command or a built-in CLI command. You can see at once ' +
      'where a command came from and why it will disappear if you switch the ' +
      'plugin off.',
    whyJump: 'You can go from here to editing',
    whyJumpText:
      'When a command has a file, the button opens it in its native section — a ' +
      'skill in Skills, a plugin command in Plugins — with the item already selected.',

    diffTitle: 'What this is NOT',
    diffCaption:
      'The section creates and edits nothing — it is a display case. Three places ' +
      'it gets confused with most often.',
    diffSkills: 'It is not "Skills"',
    diffSkillsText:
      'A skill shows up here as a row but is edited in its own section: the form, ' +
      'the file tree, the toggle and the sandbox are there. Here it only has an ' +
      '"Open" button.',
    diffPlugins: 'It is not "Plugins"',
    diffPluginsText:
      'Plugin commands are shown with the plugin name before the colon, but a ' +
      'plugin is installed, enabled and removed in its own section, through the ' +
      'official CLI.',
    diffChat: 'It is not the "/" palette in chat',
    diffChatText:
      'You cannot run a command from here: invocation stays with the chat and the ' +
      'terminal. The section answers "what do I have and whose is it", not "run it".',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'The diagram answers what no screen state shows: where each row comes ' +
        'from and why there are exactly this many built-ins.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'Every time the section opens, the server reads three directories — ' +
        'skills/, commands/ and plugins/ — and returns the list; built-in commands ' +
        'are added by the panel client from its own catalog, because the CLI does ' +
        'not expose a list of its commands. A collision on the invocation is ' +
        'resolved in favour of the file: your own /code-review hides the built-in ' +
        'of the same name. Nothing is cached and nothing is copied anywhere.',

      findTitle: 'Finding a command whose name you forgot',
      findCaption:
        'The first way in. Search covers the name, the invocation, the ' +
        "description, the owner and the command's other names; the filters narrow " +
        'the list by source.',
      fList: 'The whole set as one list',
      fListText:
        'The subtitle states the size: 111 commands. The filters next to the ' +
        'search box show what it is made of — Skills · 4, Command files · 3, ' +
        'Plugins · 3, Built-in · 101. Built-ins also show what the palette does ' +
        'not: alternative names (/background and /bg) and neighbouring commands ' +
        '("see also").',
      fSearch: 'Search over descriptions, not just names',
      fSearchText:
        'The query "релиз" finds /release-notes even though the word is not in ' +
        'the name: the description matched. The row carries the "skill" badge, the ' +
        'skills/ owner and the full path to the folder on disk.',
      fBuiltin: 'Built-ins only',
      fBuiltinText:
        'There are 101 of them, and the panel keeps that catalog itself: the CLI ' +
        'does not expose a list of its own commands. So a fresh command from a new ' +
        'CLI release shows up here later, together with a panel update.',
      fPlugin: 'Plugins only',
      fPluginText:
        'Three rows from two plugins: /code-review:review, ' +
        '/code-review:review-checklist and /sql-helper:explain. The last one is ' +
        'marked "disabled" — the plugin is off, its commands are gone from the ' +
        'palette but not from the list. The plugin name comes before the colon, ' +
        'and "nearby" shows siblings from the same plugin.',

      sourcesTitle: 'A command vanished from the palette: where to look',
      sourcesCaption:
        'The second way in. Three reasons a command exists on disk yet is not in ' +
        'the palette, and how each one looks in the list.',
      sSkill: 'A disabled skill',
      sSkillText:
        'The "Skills · 4" filter. /db-migrations is marked "disabled", and the ' +
        'path in the row points not to skills/ but to skills-disabled/ — the ' +
        'folder moved, so Claude does not scan it. Bring it back with the toggle ' +
        'in the Skills section.',
      sFiles: 'Command files: the folder becomes a prefix',
      sFilesText:
        'The "Command files · 3" filter. commands/deploy.md is called as /deploy ' +
        'and shows the argument hint "<branch>" from the file header, while ' +
        'commands/git/commit.md becomes /git:commit: the nested folder became part ' +
        'of the name. The file path is visible in the row.',
      sRegistry: 'A plugin registry of a foreign version',
      sRegistryText:
        'The panel must see exactly what the CLI sees. Claude Code does not read ' +
        'an installed_plugins.json of version 3 — and the panel says so in a line ' +
        "above the list, drops those plugins' commands and recounts everything: " +
        '111 became 108, and the Plugins filter shows 0.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config ' +
        'directory: the skills, command files and plugins in them are invented, ' +
        "while the built-ins are the panel's real catalog. They are re-shot with " +
        'node tools/help-shots/config-panel.mjs.',
    },

    storageSkills: 'Skills',
    storageFiles: 'Command files',
    storagePlugins: 'Plugins',
    storageBuiltin: 'Built-in',
    storageBuiltinValue:
      'no file — they are baked into the CLI itself; the panel keeps a list with descriptions for them',
    storageWrites: 'What the section writes',
    storageWritesValue: 'nothing: it only reads directories and shows what it found',

    sourcesTitle: 'Four sources',
    sourcesCaption:
      'The name follows the source: a skill uses its folder name, a file its path ' +
      'through a colon, a plugin its plugin name before the colon.',
    sourceSkill:
      'A skill folder: ~/.claude/skills/<name>/SKILL.md. The description comes ' +
      'from the description field, the command name matches the folder name.',
    sourceCommand:
      'The file ~/.claude/commands/<folder>/<name>.md. A nested folder becomes ' +
      'part of the name: commands/git/commit.md is called as /git:commit.',
    sourcePlugin:
      'A command or skill from an installed plugin. The plugin name comes first, ' +
      'and a disabled plugin stays in the list with a mark.',
    sourceBuiltin:
      "The CLI's own commands. They have no file and cannot be edited — the panel " +
      'keeps its own list with descriptions in both languages.',
    badgeSkill: 'skill',
    badgeCommand: 'file',
    badgePlugin: 'plugin',
    badgeBuiltin: 'built-in',

    canList: 'See every command of the active provider in one list',
    canSearch: 'Search by name, description, owner and aliases — with or without the leading "/"',
    canFilter: 'Show only skills, files, plugins or built-ins — with counters',
    canFamily: 'See which commands this one is grouped with',
    canOpen: 'Jump to editing a skill or a plugin with one button',
    canDisabled: 'See disabled skills and plugins — they are marked, not hidden',
    canProvider: 'Open the same list for Gemini, Qwen and OpenCode — from their command catalogs',

    cantEdit:
      'Edit a command right here — the section reads, editing happens in its native section',
    cantRun: 'Run a command from here — invocation stays with chat and the CLI',
    cantTranslate:
      "Translate other people's descriptions: a skill or plugin description is shown exactly " +
      'as written in the file',
    cantFresh:
      'Learn about a new built-in command without updating the panel: the CLI does not expose its list',
    cantProject:
      "See a project's commands: the section reads personal directories, while a project's " +
      '.claude/commands lives in the Projects section',

    familyTitle: 'Command groups',
    familyCaption:
      'Commands often come in sets. The panel works the group out itself, by name ' +
      'and owner, and shows the siblings right in the row.',
    familyPrefix: 'By the start of the name',
    familyPrefixText:
      'Commands sharing a first word count as one group: /design-sync and ' +
      '/design-login. A group of one is not shown.',
    familyOwner: 'By owner',
    familyOwnerText:
      'Everything a single plugin brings is one group, whatever the names. That ' +
      'makes it visible that removing the plugin takes all of its commands away.',

    limitsTitle: 'The limits of the section',
    limitsCaption:
      'The numbers and conditions people trip over most. Everything listed here ' +
      'is visible in the frames above.',
    limitWrite: 'Writing',
    limitWriteValue: 'there is none at all: the section only reads directories and changes nothing',
    limitCollision: 'Name collision',
    limitCollisionValue:
      'your file wins: the stand’s code-review and release-notes skills hide the built-ins of ' +
      'the same name, which is why the frame shows 101 built-ins while the panel catalog ' +
      'holds 103',
    limitRegistry: 'Plugin registry',
    limitRegistryValue:
      'version 2 only. For any other version Claude Code answers with an empty list — the panel ' +
      'shows the same thing and states the reason in a line',
    limitFiles: 'How many files are read',
    limitFilesValue:
      'up to 500 per directory. The description is trimmed at 400 characters: a longer one does ' +
      'not fit the card anyway',
    limitDescription: 'Where the description comes from',
    limitDescriptionValue:
      'the description field of the file header, otherwise the first non-empty line of the body. ' +
      'No header — the first line is used; nothing found — the card stays without a description',
    limitBuiltins: 'Built-ins',
    limitBuiltinsValue:
      'the catalog is kept by the panel and checked against the Claude Code reference; commands ' +
      'removed from the CLI are shown with a mark so nobody hunts for them',

    notesTitle: 'Things people trip over',
    noteReadOnlyTitle: 'The section changes nothing',
    noteReadOnlyText:
      'There are no forms and no save buttons here: it is a display case. Every ' +
      'edit goes through the Skills or Plugins section, where the button takes you.',
    noteAutoTitle: 'Your commands appear on their own',
    noteAutoText:
      'The list is read from disk every time the section opens. A new skill, a new ' +
      'file in commands/ or an installed plugin shows up with no setup — anyone ' +
      "who installs the panel gets their own commands, not someone else's.",
    noteBuiltinTitle: 'Built-ins are checked against the documentation',
    noteBuiltinText:
      'The list of built-in commands is kept by the panel — the CLI cannot ' +
      'enumerate them. It is checked against the Claude Code reference and updated ' +
      'together with the panel, so a fresh command from a new CLI release may ' +
      'appear here later.',
    noteDisabledTitle: 'Disabled things are marked, not hidden',
    noteDisabledText:
      'A disabled skill and the commands of a disabled plugin stay in the list ' +
      "with a mark. That is deliberate, because of the section's main question: " +
      'someone is looking for a command that is missing from the palette, and they ' +
      'need to see that it is on disk and why it does not work.',
    noteDescTitle: 'The description comes from the file',
    noteDescText:
      'For skills and plugins the panel shows their own description and does not ' +
      'translate it: whatever language the file is in, that is what you see. ' +
      'Switching the language changes the interface and the built-in descriptions.',
    noteProviderTitle: 'With other providers',
    noteProviderText:
      'Gemini and Qwen keep commands in commands/**/*.toml files (description from ' +
      'the description field, otherwise the first line of prompt), OpenCode in ' +
      'commands/*.md and in the command key of opencode.json. For the other CLIs ' +
      'the format of user commands is not described in the documentation, so the ' +
      'section is hidden for them: the panel does not invent a format that the ' +
      'documentation does not have.',

    undoTitle: 'A command is nowhere to be seen — what to do',
    undoCaption:
      'There is nothing to undo here: the section writes nothing. What it does do ' +
      'is show the reason, and each one is fixed in its own place.',
    undoSkill: 'The row is there, marked "disabled"',
    undoSkillText:
      'That is a skill in skills-disabled/ or a command of a disabled plugin. The ' +
      'toggle is in the Skills or Plugins section; the "Open" button takes you ' +
      'straight there.',
    undoRegistry: 'A line about the plugin registry above the list',
    undoRegistryText:
      'The installed_plugins.json version is not the one the CLI reads. Plugin ' +
      'commands will appear neither here nor in the palette until the registry is ' +
      'version 2 — reinstall the plugins with the official command.',
    undoNothing: 'There is no row at all',
    undoNothingText:
      'The file is not where it is looked for: a skill is a folder with SKILL.md ' +
      'inside skills/, a command is a .md inside commands/. Check the extension ' +
      'and the place — the list is re-read every time the section opens.',
    undoRestart: 'The row is there but the palette does not know it',
    undoRestartText:
      'Claude Code reads the directories when a session starts. A new skill or ' +
      'command file is picked up by the next session, not by an open conversation.',
  },

  shots: {
    find: {
      '01-list': 'The whole set: 111 commands and source filters with counters',
      '02-search': 'The query "релиз" found /release-notes by description, not by name',
      '03-builtin': 'Built-ins only: 101 commands, whose catalog the panel keeps itself',
      '04-plugin': "Commands of two plugins; the disabled plugin's ones are marked",
    },
    sources: {
      '01-skill': 'Skills: a disabled one points to skills-disabled/ and stays in the list',
      '02-files': 'Command files: the nested folder became the /git:commit prefix',
      '03-registry': 'Version 3 is not read by the CLI: a line with the reason, 111 became 108',
    },
  },

  diagrams: {
    'four-sources':
      'Where every row comes from: the server reads three directories on disk, the panel adds the built-ins itself, and on a collision your own file wins.',
  },
};
