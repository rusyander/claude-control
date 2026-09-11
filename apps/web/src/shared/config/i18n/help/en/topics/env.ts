import type { envRu } from '../../ru/topics/env';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const envEn: typeof envRu = {
  topic: {
    title: 'Environment',
    summary: 'Settings and tokens: three files, two attitudes to secrets, different readers',
    lead:
      'Environment variables are how a value reaches a place it should never be ' +
      'hard-coded into: an access token, an instance address, a mode flag. This ' +
      'section manages three files at once, and the difference between them matters: ' +
      'two are read by Claude Code itself, the third exists purely for secrets, is ' +
      'read by the panel, and never travels into a repository with your configuration.',

    guideTitle: 'How to read this page',
    guideText:
      'The diagram first: three files, which of them is read by whom, and in what order ' +
      'a value is substituted into an MCP server entry. Then two paths in screenshots — ' +
      '“add a token” is walked once per secret, “move a batch” is for when many variables ' +
      'arrive at once and have to be filed. After the screenshots: what the section writes ' +
      'on disk, the refusals with their causes, and the things people trip over.',

    whySeparate: 'Secrets apart from settings',
    whySeparateText:
      'Tokens live in their own file rather than in the shared configuration. You can ' +
      'show, export or copy that configuration without carrying keys along.',
    whyMasked: 'The value is never revealed by accident',
    whyMaskedText:
      'Secrets arrive from the server already masked — only the start and the tail are ' +
      'visible. The full value is fetched separately and only on your action.',
    whyBulk: 'A whole .env moves at once',
    whyBulkText:
      'A batch of variables can be pasted line by line as is. The panel files secrets ' +
      'and ordinary settings into different places itself.',

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours Environment gets confused with most often.',
    notColumn: 'Neighbouring section',
    notMeaningColumn: 'What it does instead',
    notMcp: 'MCP servers',
    notMcpText:
      'There you write a ${NAME} reference into the server fields; the value itself is ' +
      'created here. The reverse — a token right in the server entry — is the mistake this ' +
      'separation exists for.',
    notSettings: 'Settings',
    notSettingsText:
      'Those are the panel’s own settings: theme, port, check behaviour. This is the ' +
      'environment Claude Code and its tools will receive.',
    notGroups: 'Groups',
    notGroupsText:
      'A variable set by an enabled group is visible here with a badge but edited in the ' +
      'group card: deleted here, the group would bring it back the next time it is enabled.',
    notProjects: 'Projects',
    notProjectsText:
      'The set of variables is shared across the installation. There is no per-project set — ' +
      'Projects manages directories, copies and a project’s MCP servers, not its environment.',
    notSecurity: 'Data protection',
    notSecurityText:
      'Masking in the list is about the screen, not the storage: in the file the value is ' +
      'plain text. Encrypted backups and keeping secrets out of exports live there.',

    mapTitle: 'How it works',
    mapCaption:
      'The real decision in the form is the file. Who reads the value, and whether it is ' +
      'masked in the list, both follow from it.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A value lands in one of three files. settings.json → env and settings.local.json → ' +
      'env are read by Claude Code itself when a session starts, and from there the ' +
      'variables reach the agent’s environment. The .mcp-secrets.env file is read by the ' +
      'PANEL: from it, ${NAME} is expanded into the command, arguments, headers and env of ' +
      'an MCP server entry — before a connection check and before a sandbox launch. All ' +
      'three files are searched at once, plus the panel’s own environment; on a name clash ' +
      '.mcp-secrets.env wins. A name found nowhere is named outright in the failure reason. ' +
      'The mask in the list follows the variable’s name, not its file: the whole word ' +
      'TOKEN, SECRET, KEY, PASSWORD, PAT or CREDENTIAL between underscores.',

    guide: {
      secretTitle: 'Path 1. Add a token: from a plain list to a revealed value',
      secretCaption:
        'Walked once per secret. It is also where you see why the value field is empty ' +
        'when you edit one.',
      secretPlain: 'A list with settings only',
      secretPlainText:
        'So far there is one ordinary variable: a name, the settings.json file and the ' +
        'value 120000 in plain text. The file is printed on every row — the first thing to ' +
        'check when a value “never arrived”.',
      secretForm: 'The form: name, value and the choice of file',
      secretFormText:
        'The “Where to save” field proposes .mcp-secrets.env — the only one of the three ' +
        'files that does not travel into a repository. The file is your choice: in the ' +
        'single-variable form it is NOT guessed from the name, detection only runs on bulk ' +
        'add. Fill the comment in right away — six months later it is the only thing that ' +
        'explains where to reissue the key.',
      secretMasked: 'The secret is masked in the list',
      secretMaskedText:
        'Only the start and the tail: whk_••••••••••••a1d2. Beside it the comment “Warehouse ' +
        'account → Access → Create token”, stored in the file above the variable’s line and ' +
        'surviving every rewrite.',
      secretReveal: 'Revealing the value is a separate action',
      secretRevealText:
        'The full text does not travel with the list: it is fetched on a button press and ' +
        'only then. Before the click the value is not even in the server’s answer.',
      secretEdit: 'Editing a secret: the value field is empty',
      secretEditText:
        'The panel received the value masked and cannot put it back — a string of dots ' +
        'would end up in the file. “Leave empty if the value should stay.” The file is ' +
        'fixed by the record: the variable returns where it came from.',

      bulkTitle: 'Path 2. Move a batch: a whole .env, local and group variables',
      bulkCaption:
        'You come here when many variables arrive at once — from someone’s .env, from an ' +
        'instruction, from another machine.',
      bulkPaste: 'Paste the list as is',
      bulkPasteText:
        'Every line is one record, blank lines are skipped. The panel parses as you type: ' +
        '“5 recognised”, with the destination file shown on each line. Detection does run ' +
        'here — the two names carrying TOKEN and KEY are marked .mcp-secrets.env, the other ' +
        'three go to settings.json.',
      bulkList: 'The list after creation',
      bulkListText:
        'Ordinary variables show their values, secrets show masks whk_••••••••••••a1d2 and ' +
        'dl_7•••••••aa93. Each row carries its own file, and that is what answers “why is ' +
        'one visible and the other not”.',
      bulkMove: 'Moving between settings.json and the personal file',
      bulkMoveText:
        'The button moves a variable into settings.local.json — entries from there carry a ' +
        '“local” badge. The panel also reports the backup: “Moved · copy: settings.json.…bak”. ' +
        'A secret cannot be moved this way: .mcp-secrets.env has a nature of its own.',
      bulkGroup: 'Group variables are visible but not editable',
      bulkGroupText:
        'An enabled group added two variables of its own: the badge “group: Release check” ' +
        'and neither an edit nor a delete button. They live in the same settings.json but ' +
        'belong to the group — change them in its card.',
      bulkDelete: 'Deletion is confirmed by name',
      bulkDeleteText:
        'The dialog asks for the variable’s full name and warns plainly: “Servers that use ' +
        'it will stop receiving this value.” Deletion has no undo — it has a backup of the ' +
        'file in the change history.',
    },

    canTwo: 'Keep variables in three files: two for Claude Code and one for secrets',
    canReveal: 'Reveal the full value of a secret with a button',
    canBulkAdd: 'Paste a batch of KEY=value lines, up to a whole .env',
    canComment: 'Leave a comment: where the value comes from or what it is for',
    canAssistant: 'Fill the form with the assistant by describing the variable in words',
    canAuto:
      'Rely on detection when adding in bulk: a name carrying TOKEN goes to the secrets file',
    canMove: 'Move a variable between settings.json and settings.local.json with a button',
    canSubstitute: 'Reference a variable from an MCP server entry as ${NAME} or ${NAME:-fallback}',

    cantEncrypt:
      'Encrypt the values: the token file is protected by file permissions, not a cipher',
    cantEdit:
      'Adjust a secret without retyping it: the panel does not know the old value — it ' +
      'only ever received it masked',
    cantScope: 'Split variables per project — the set is shared',
    cantSee: 'See which variable actually reached a process: the panel only writes them',
    cantMoveSecret:
      'Move a secret out of .mcp-secrets.env with the move button — the source is left untouched',
    cantGroupEdit:
      'Edit an enabled group’s variable from here: it would come back the next time the ' +
      'group is enabled',

    storageSettings: 'Settings',
    storageSettingsValue: '~/.claude/settings.json → the env key',
    storageLocal: 'The personal file',
    storageLocalValue:
      '~/.claude/settings.local.json → read and written; entries carry a "local" badge',
    storageSecrets: 'Secrets',
    storageSecretsValue: '~/.claude/.mcp-secrets.env',
    storageWhoReads: 'Who reads what',
    storageWhoReadsValue:
      'settings.json and settings.local.json — Claude Code itself, at session start; ' +
      '.mcp-secrets.env — the panel, expanding ${NAME} in MCP server entries and in the sandbox',
    storageDetect: 'How a secret is detected',
    storageDetectValue:
      'by name, as a whole word between underscores: TOKEN, SECRET, KEY, PASSWORD, PAT, ' +
      'CREDENTIAL — GIT_BASH_PATH and MAX_TOKENS are not secrets',
    storageComments: 'Comments',
    storageCommentsValue:
      'the line above a variable survives a rewrite of the file — hand edits are not lost',
    storageBackup: 'Backups',
    storageBackupValue:
      'a <file>.<timestamp>.bak is made before writing; copies of .mcp-secrets.env are ' +
      'plain text by default, encryption is switched on in the settings',
    storageWhen: 'When it takes effect',
    storageWhenValue:
      'after Claude Code is restarted — the environment is read when a session starts',

    placesTitle: 'Three files, three jobs',
    placeSettings: 'Claude Code settings',
    placeSettingsText:
      'Values Claude Code itself sees at launch. Everything non-secret goes here: modes, ' +
      'addresses, behaviour flags. The file is shared and usually kept in a settings repository.',
    placeLocal: 'The personal file',
    placeLocalText:
      'settings.local.json — the same thing, but only on this machine. Values that must not ' +
      'travel to colleagues go here: local addresses, personal paths.',
    placeSecrets: 'The token file',
    placeSecretsText:
      'A separate file the panel reads when expanding ${NAME}. It exists precisely so that ' +
      'keys stay out of the shared configuration, which gets shown, copied and exported more ' +
      'often than people think.',

    fieldsTitle: 'Fields of a variable',
    fieldsCaption: 'Names match the envVarDraftSchema schema.',
    fieldKey: 'The variable name in upper case with underscores.',
    fieldValue:
      'The value. For .mcp-secrets.env it must be a single line: a line break would become ' +
      'a separate variable, and the panel refuses such a record. When editing a secret the ' +
      'field is empty: the panel does not know the old one.',
    fieldSource:
      'Where to save it — chosen on creation: settings — visible to Claude Code, secrets — ' +
      'the token file. When editing, the file follows the record and does not change.',
    fieldIsSecret:
      'Whether the variable counts as a secret. Not set by hand — detected from the name.',
    fieldComment:
      'A comment above the variable in the file: where the value comes from or what it is for.',

    refusalsTitle: 'Refusals and what to do',
    refusalsCaption: 'What the panel says on the left; what it means on the right.',
    refusalsColumn: 'What the panel says',
    refusalsMeaningColumn: 'What to do',
    refusalMultiline: 'A value for .mcp-secrets.env is a single line',
    refusalMultilineText:
      'A line break got into the value, and the file’s format is line by line: the second ' +
      'line would become a separate variable. Remove the break — or keep multi-line values ' +
      'in settings.json.',
    refusalSecretEdit: 'The value field is empty when editing a secret',
    refusalSecretEditText:
      'Not a fault: the panel only ever received the value masked. An empty field means ' +
      '“leave as it was”, a typed one replaces it whole.',
    refusalGroup: 'A variable has no edit or delete buttons',
    refusalGroupText:
      'It is set by an enabled group — the “group: name” badge sits beside it. Change it in ' +
      'the group card; it goes away when the group is disabled.',
    refusalMoveSecret: 'Moving a secret did nothing',
    refusalMoveSecretText:
      'The move button works between settings.json and settings.local.json. ' +
      '.mcp-secrets.env is not part of that pair: create the variable anew and delete the old one.',
    refusalNotApplied: 'The variable is created but the server does not see it',
    refusalNotAppliedText:
      'The environment is read at startup. Open a new Claude Code session — a running one ' +
      'will not receive new variables.',
    refusalUnknownVar: 'An MCP server says “Variables ${…} are not set”',
    refusalUnknownVarText:
      'The name in the server entry was found in none of the three files nor in the panel’s ' +
      'environment. Create it here, spelled exactly the same — case matters.',

    notesTitle: 'Things people trip over',
    noteRewriteTitle: 'A secret is retyped when edited',
    noteRewriteText:
      'The panel received the value masked and cannot put it back: a string of dots would ' +
      'end up in the file. The field is deliberately left empty.',
    noteDetectTitle: 'Secret detection works by name',
    noteDetectText:
      'A variable called API_ENDPOINT lands in ordinary settings even if you keep ' +
      'something sensitive in it — check the chosen file before saving. The word counts ' +
      'only as a whole: GIT_BASH_PATH and MAX_THINKING_TOKENS stay ordinary settings, ' +
      'GITHUB_PAT and ANTHROPIC_API_KEY are secrets. The rule is the same for bulk add and ' +
      'for the server: the file the parsed list proposes matches the mask in the list. In ' +
      'the SINGLE-variable form you pick the file yourself.',
    noteReaderTitle: 'The token file is read by the panel, not by Claude Code',
    noteReaderText:
      'Values from .mcp-secrets.env are expanded into MCP server entries during a connection ' +
      'check and in the sandbox. Claude Code never opens that file: a variable the agent ' +
      'needs as environment belongs in settings.json → env.',
    noteLocalTitle: 'Variables from settings.local.json are edited right here',
    noteLocalText:
      'The panel reads both the main settings.json and the personal ' +
      'settings.local.json, so the list shows everything that will really reach the ' +
      'environment. Entries from the personal file carry a “local” badge, and an edit ' +
      'goes back to exactly the file it came from. The file cannot be picked by hand: ' +
      'it follows the record — otherwise a variable would quietly split in two.',
    noteGroupTitle: 'Group variables are marked and edited in the group',
    noteGroupText:
      'A variable set by an enabled group lives in settings.json, but the list marks it ' +
      'with a “group: name” badge and shows no edit or delete buttons: deleted here, the ' +
      'group would bring it back the next time it is enabled. Change it in the group card ' +
      '(the Groups section); it is removed there too, together with disabling the group.',
    noteCommentsTitle: 'Comments in the token file survive',
    noteCommentsText:
      'The panel rewrites the file but carries the comments above variables across. Hand ' +
      'edits are not lost.',
    noteRevealTitle: 'Revealing a value is a separate request',
    noteRevealText:
      'The full text of a secret does not travel with the list: it is fetched only on a ' +
      'click. The default behaviour can be changed in the application settings.',
    noteProviderTitle: 'Other providers, other file',
    noteProviderText:
      'With the Codex provider the variables live in the shell_environment_policy.set table ' +
      'of config.toml, with Aider in the set-env key of .aider.conf.yml (the global one ' +
      'or the one in the repository root), with Gemini ' +
      'in the plain ~/.gemini/.env file (and the per-project .gemini/.env), with Qwen Code ' +
      'in ~/.qwen/.env (and the per-project .qwen/.env), with Continue in ~/.continue/.env ' +
      '(and the per-project .continue/.env, the source of ${{ secrets.NAME }} values). Comments, ' +
      'blank lines and ordering survive the write: only the lines of the affected ' +
      'variables change. For OpenCode the section is “in development”; for Cursor it is ' +
      'hidden. Secrets in .mcp-secrets.env ' +
      'and masking are Claude capabilities too. For Goose the section is hidden as well: it ' +
      'loads no .env of its own — values come from the process environment and secrets from ' +
      'the OS keyring. Kimi Code is hidden for the same reason: it reads no .env of its ' +
      'own, provider keys sit right in config.toml, and the panel never writes secrets ' +
      'into a foreign config.',
  },

  shots: {
    secret: {
      '01-list-plain':
        'A list with one ordinary variable: the settings.json file and the value 120000 in plain text',
      '02-form':
        'The single-variable form: “Where to save” proposes .mcp-secrets.env, with the comment field beside it',
      '03-list-masked':
        'The secret in the list: the mask whk_••••••••••••a1d2 and a comment on where to issue the token',
      '04-revealed':
        'After the reveal press the value is shown whole — fetched by a separate request',
      '05-secret-edit':
        'Editing a secret: the value is empty, “Leave empty…”, and the file is fixed by the record',
    },
    bulk: {
      '01-bulk':
        'The pasted list: “5 recognised”, the destination file on every line, the “Create all (5)” button',
      '02-list-mixed':
        'Six variables after creation: four values in plain text, two secrets as masks',
      '03-local':
        'Moved to the personal file: the “local” badge and the message about the settings.json backup',
      '04-group':
        'Two variables of an enabled group: the badge “group: Release check” and no edit buttons at all',
      '05-delete': 'Deletion is confirmed by typing the variable’s full name',
    },
  },

  diagrams: {
    'where-a-value-goes':
      'Three files, their readers and the order in which ${NAME} is expanded into an MCP server entry',
  },
};
