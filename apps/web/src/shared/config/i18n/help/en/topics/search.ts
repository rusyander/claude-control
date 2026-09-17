import type { searchRu } from '../../ru/topics/search';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const searchEn: typeof searchRu = {
  topic: {
    title: 'Search',
    summary: 'One line searches every configuration section at once',
    lead:
      'Search answers “where did I configure this” without walking the sections one ' +
      'by one. A single line goes through rules, skills, hooks, scripts, permissions, ' +
      'environment variables, MCP servers and plugins, and a click on a hit opens it ' +
      'inside its own section. There is no index of its own: search reads the same ' +
      'configuration the sections show, so the results cannot be stale.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: which fields are walked, what is not part of the sweep at ' +
      'all, and why variables are visible by key name only. Then one path in ' +
      'screenshots — search has exactly one entrance, the query line, and splitting it ' +
      'into scenarios would misrepresent the interface. After the screenshots: what ' +
      'the section is not, what it reads and writes, its limits, the per-section field ' +
      'table and the fine print.',

    whyOne: 'One entrance instead of a tour',
    whyOneText:
      'No need to remember where exactly a setting lives: the query goes through all ' +
      'sections at once and the results are grouped by kind.',
    whyCross: 'Finds by name and by content',
    whyCrossText:
      'It searches the title and the body alike: a hook’s command, a permission ' +
      'pattern, a variable name, an MCP server address.',
    whySafe: 'It does not reveal secrets',
    whySafeText:
      'For environment variables it searches and shows the key name only — the value, ' +
      'even masked, never reaches the results.',

    mapTitle: 'What search walks through',
    mapCaption:
      'Search goes through the fields of records, not whole files. The diagram shows ' +
      'which fields those are, what replaces the set of sections, and what is not here ' +
      'at all.',
    pathTextTitle: 'The same in words',
    pathTextText:
      'A query shorter than two characters starts nothing: no disk is read, no CLI is ' +
      'called. From two characters the panel collects the sections with the same ' +
      'readers the pages use and picks records by substring, case-insensitively. ' +
      'Environment variables are a rule apart: only the key name is compared, the ' +
      'value takes no part in the search and never reaches the snippet. While Claude ' +
      'is active its configuration is walked; pick another CLI and its own is searched ' +
      'instead, and only the sections the panel maintains for it. Test cases join in ' +
      'when a project tab is open: they live in the project itself. The results are ' +
      'grouped by section in navigation order, and a click opens the section with the ' +
      'record highlighted.',

    guide: {
      findTitle: 'The path. Find where it is configured',
      findCaption:
        'The section’s only entrance is the query line. Inside the path are the three ' +
        'outcomes most often mistaken for breakage: hits in two sections at once, ' +
        'variables without values, and an honest “nothing found”.',
      findPrompt: 'An empty line is a state, not an error',
      findPromptText:
        'While fewer than two characters are typed, search does not run at all, and ' +
        'the screen says so plainly. Nothing is read and nothing is called: an empty ' +
        'page costs nothing here.',
      findTwo: 'One word — hits in different sections',
      findTwoText:
        'The word occurs both in a rule’s text and in a permission pattern. Sections ' +
        'follow navigation order, each with its own counter and the total above them. ' +
        'Under a hit’s title stands the snippet around the match, which shows what ' +
        'exactly matched.',
      findEnv: 'Variables are shown by key name only',
      findEnvText:
        'Both matches are variable names; the value is neither in the title nor in the ' +
        'snippet, and will not be there even masked. A variable therefore cannot be ' +
        'found by its value — only by its name.',
      findEmpty: '“Nothing found” is an answer, not a failure',
      findEmptyText:
        'The screen repeats the query itself: that word occurs in none of the fields ' +
        'search walks. A space is not “and”: the whole string is searched as one, which ' +
        'is why a two-word phrase often finds nothing while each word alone does.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours search is confused with most often.',
    notColumn: 'Neighbouring search',
    notMeaningColumn: 'What is searched there',
    notChat: 'Chat search',
    notChatText:
      'Conversations are searched in the chat list — by the body of the messages. This ' +
      'section is about configuration and knows nothing about conversations.',
    notFiles: 'Project files',
    notFilesText:
      'This is not a code search: repository files are not read at all. The editor and ' +
      'the agent itself are for those.',
    notOverview: 'Overview',
    notOverviewText:
      'The overview answers “how many”, search answers “where exactly”. Tile numbers ' +
      'and search results are counted by different paths and do not describe the same ' +
      'thing.',
    notSection: 'The setting’s own section',
    notSectionText:
      'Nothing can be changed from the results: a click opens the record in its ' +
      'section, and editing lives there.',
    notCommands: 'Slash commands',
    notCommandsText:
      'The panel maintains commands in their own section, but they are not part of the ' +
      'search sweep — look for them in the command list itself.',

    storageWhere: 'What it searches',
    storageWhereValue: 'the current configuration, not a database of its own — search has no index',
    storageScope: 'Sections',
    storageScopeValue:
      'rules, skills, hooks, scripts, permissions, variables, MCP, plugins, panel ' +
      'groups and the test cases of an open project',
    storageNever: 'What it never opens',
    storageNeverValue:
      'provider-keys.enc, provider-keys.key; from .mcp-secrets.env only key names are taken, values never take part in search',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing. Search is a read operation: it changes neither configuration files nor ' +
      'the panel’s own',
    storageWhen: 'When it runs',
    storageWhenValue:
      'on every pause in typing of about a quarter of a second, with a query of two ' +
      'characters or more; the plugin catalogue is taken from a cache rather than from ' +
      'the CLI again',
    storageClaude: 'When Claude sees it',
    storageClaudeValue: 'never — search changes nothing, so there is nothing to see',

    canAll: 'Search every configuration section at once with a single line',
    canGrouped: 'See results grouped by section, with a snippet around the match',
    canOpen: 'Open a hit inside its own section, with the record highlighted',
    canLive: 'Search the current state: the same files the sections read',
    canTests: 'Find the test cases of an open project — including by the text of the steps',

    cantBody: 'Search the body of a conversation: that is a separate search in the chat list',
    cantSecrets: 'Find a secret’s value: only key names are available for variables',
    cantEdit: 'Edit a hit straight from the results — editing lives in the section itself',
    cantRegex: 'Search by mask or regular expression: a plain substring is compared',

    limitsTitle: 'Limits and refusals',
    limitsCaption:
      'When search stays silent or answers something other than expected — and what to ' +
      'do about it.',
    limitsColumn: 'What happens',
    limitsMeaningColumn: 'Why, and what to do',
    limitShort: 'A query shorter than two characters',
    limitShortText:
      'Search does not run: a single letter would match almost everything. The screen ' +
      'stays in the “start typing” state. There is nothing to undo — add a character.',
    limitEmpty: '“Nothing found”',
    limitEmptyText:
      'None of the fields in the table below contains that substring. A common cause is ' +
      'a multi-word phrase: the whole string is searched as one. Try a single word or ' +
      'part of it.',
    limitEnv: 'A variable is not found by its value',
    limitEnvText:
      'By design: the value is dropped at the source and simply does not exist further ' +
      'down the pipeline. Search by key name; to see the value, open the variables ' +
      'section.',
    limitProvider: 'Another CLI is active — the results are different',
    limitProviderText:
      'The active tool’s configuration is searched, not Claude’s: its instructions ' +
      'file, MCP servers, variables, permissions. Sections the panel does not maintain ' +
      'for it never appear — otherwise a result would lead to a page that is closed. ' +
      'Making Claude active restores the previous coverage.',
    limitBroken: 'A section with a broken config silently dropped out',
    limitBrokenText:
      'If a section’s file does not parse, search skips that section instead of failing ' +
      'entirely. The section itself shows the reason: open it and fix the file.',
    limitPlugins: 'A just-installed plugin is not found',
    limitPluginsText:
      'The plugin catalogue is requested from the CLI and cached: running it on every ' +
      'typed character would cost more than the rest of the search. The fresh list ' +
      'appears in the plugins section and then in the results.',

    fieldsTitle: 'Which fields are walked',
    fieldsCaption:
      'The answer to “why was it not found”. A match is a substring in any of the ' +
      'listed fields; case does not matter.',
    fieldsMatchColumn: 'Fields a match is looked for in',
    fieldRules: 'Rules',
    fieldRulesText: 'The rule’s title and text.',
    fieldSkills: 'Skills',
    fieldSkillsText: 'The skill’s identifier, name, description and body.',
    fieldHooks: 'Hooks',
    fieldHooksText:
      'The event, the matcher, the command and the description from the script header.',
    fieldScripts: 'Scripts',
    fieldScriptsText: 'The file name, the path and the description from the header.',
    fieldPermissions: 'Permissions',
    fieldPermissionsText:
      'The pattern, the decision (allow / ask / deny), the MCP server and tool name.',
    fieldEnv: 'Environment variables',
    fieldEnvText:
      'The key name only. The value takes no part in the search and never reaches the ' +
      'snippet — neither whole nor masked.',
    fieldMcp: 'MCP servers',
    fieldMcpText: 'The name, command, address, arguments and transport.',
    fieldPlugins: 'Plugins',
    fieldPluginsText: 'The identifier, name, marketplace and description.',
    fieldGroups: 'Panel groups',
    fieldGroupsText:
      'The name and description. A group has no Claude Code files, but it does have a ' +
      'section — without it “search across all sections” would be a lie.',
    fieldTests: 'Project test cases',
    fieldTestsText:
      'The title, purpose, area, section, tags and the text of the steps — people ' +
      'usually search by what was clicked. Available only while a project tab is open.',

    noteSecretTitle: 'Secret values never reach this page',
    noteSecretText:
      'For environment variables search works with key names alone. The .mcp-secrets.env ' +
      'file is read just like settings.json, but secret values take part neither in a ' +
      'match nor in a snippet — only the key name can be found. The provider key store is ' +
      'not opened at all.',
    noteSubstringTitle: 'A match is a plain substring',
    noteSubstringText:
      'Case does not matter, “migr” finds migrations. No masks and no regular ' +
      'expressions: an asterisk is searched as an asterisk. A space is not “and” — the ' +
      'whole string is searched as one.',
    noteSnippetTitle: 'The snippet is a window around the match',
    noteSnippetText:
      'About forty characters on each side, with line breaks collapsed into spaces. If ' +
      'the match came from a field that is not on screen (an identifier, say), the ' +
      'beginning of the description is shown — and then there is nothing to highlight.',
    noteChatTitle: 'A different search covers the conversation',
    noteChatText:
      'This section searches the configuration. To find a conversation by what was ' +
      'discussed in it, there is a search over message bodies in the chat list.',
    notePauseTitle: 'The query leaves on a pause in typing',
    notePauseText:
      'While you type, the previous hits stay on screen and a new query leaves about a ' +
      'quarter of a second after the last character. The list does not flash empty on ' +
      'every letter, but it is not obliged to be instant either.',
  },

  shots: {
    find: {
      '01-prompt':
        'The section is open with an empty line: “Start typing a query — it searches every configuration section at once. Two characters are enough”',
      '02-two-sections':
        '“Found: 2” for the word migrations: “Rules 1” — the rule “Do not touch the migrations directory”, “Permissions 1” — deny: Edit(migrations/**)',
      '03-variables':
        '“Found: 2” for the word TOKEN, both hits in “Environment variables”: MAX_THINKING_TOKENS and SHOP_API_TOKEN — the card carries the key name only',
      '04-empty':
        '“Nothing found. No matches for “выгрузка склада”” — the screen names the query itself',
    },
  },

  diagrams: {
    'what-search-covers':
      'What search walks through: the fields of records per section, the separate rule for variables, the snippet window and the list of what it does not find',
  },
};
