import type { projectsRu } from '../../ru/topics/projects';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const projectsEn: typeof projectsRu = {
  topic: {
    title: 'Projects',
    summary: 'The project level: a folder’s own CLAUDE.md, MCP servers and permissions',
    lead:
      'Beyond the user-level ~/.claude, the panel can manage a specific project’s ' +
      'configuration. Open a folder and edit its own CLAUDE.md, .mcp.json and ' +
      '.claude/settings.json, while the repository’s own .claude is shown as it is, with ' +
      'no right to edit. The project level is added on top of the user level, not ' +
      'instead of it.',

    guideTitle: 'What is inside',
    guideText:
      'First why this exists and what the section is NOT. Then two diagrams and two ' +
      'paths in real frames: a folder becoming a project, and what a repository with a ' +
      'ready .claude looks like. At the end — what goes to disk, the fields, the ' +
      'boundaries, the traps and how to undo.',

    whyLevel: 'Settings next to the code',
    whyLevelText:
      'A project’s rules, MCP servers and permissions live in its directory and travel ' +
      'with the repository — the whole team sees them, not just your machine.',
    whyAdditive: 'On top of the user level',
    whyAdditiveText:
      'The project level is added to your own ~/.claude rather than replacing it: shared ' +
      'settings stay in place, and the project ones apply in that directory only.',
    whySame: 'The same forms',
    whySameText:
      'A project’s files use the same format as the user level, so rules, MCP servers ' +
      'and permissions are edited with the familiar forms, not as raw JSON.',

    diffTitle: 'What this section is NOT',
    diffCaption:
      'The four things it gets mistaken for. No screenshot refutes any of them: in each ' +
      'case the screen looks exactly the way the reader expects.',
    diffUser: 'Not the user-level rules',
    diffUserText:
      'The Rules, MCP servers and Permissions sections still manage ~/.claude. This is ' +
      'one directory’s files, and they affect no other project.',
    diffLocal: 'Not an editor for the project’s .claude',
    diffLocalText:
      'The «From the project» tab only shows the repository’s skills, hooks and rules. ' +
      'It has no toggles and no forms: that set belongs to git and is edited there, like code.',
    diffGroups: 'Not groups and not the sandbox',
    diffGroupsText:
      'There is nothing here to switch a project rule or hook off with, and no way to ' +
      'run a project’s set in the sandbox. Toggles, groups and the sandbox exist on the ' +
      'user level only.',
    diffGit: 'Not a git client',
    diffGitText:
      'Saving edits the repository’s working tree and will land in the branch together ' +
      'with the code. This section itself commits nothing and never checks whether the ' +
      'tree is clean. The panel does have git, just elsewhere: the bar above a project’s ' +
      'chat can branch, commit, pull and push, it creates parallel copies of branches, ' +
      'and each copy’s card shows how complete it is — what is missing and whether the ' +
      'access entry is there; «Fill in» carries the missing part over again. What the ' +
      'panel never does anywhere is merging — merging branches stays with you.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams: what «add a project» does to disk, and why the same project looks ' +
        'different under another CLI. A screenshot shows the tabs, not what lies behind them.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        '«Add a project» → browse folders → «Open this folder». Nothing appears in the ' +
        'repository at that moment: the panel remembers the path on its own side. A ' +
        'project’s files change only when you press «Save» on a tab — and before every ' +
        'write the panel puts a backup aside. Claude Code reads those files when a ' +
        'session starts, together with your personal ones.',

      setupTitle: 'Path one: a folder becomes a project',
      setupCaption:
        'Walked once per project. Six frames: the empty registry, the folder browser, ' +
        'the three configuration tabs and the same project through another CLI’s eyes.',
      sEmpty: 'The empty section',
      sEmptyText:
        'The registry is empty and the panel says what will appear here. Claude Code ' +
        'knows nothing about this list: it exists so the panel remembers which folders ' +
        'you manage.',
      sPicker: 'The folder browser',
      sPickerText:
        'Drives and directories are read by the panel’s server, not by the browser: any ' +
        'folder on the machine is reachable, even one where Claude Code has never run. ' +
        '«Open this folder» takes the current directory — C:/work in the frame.',
      sRules: 'Project rules: its whole CLAUDE.md',
      sRulesText:
        'One text field, a character counter at the bottom (307 in the frame) and a ' +
        'reminder that changes apply after Claude Code restarts. The project level has ' +
        'no separate rules, toggles or groups: the file is edited as a whole.',
      sMcp: 'The project’s MCP servers',
      sMcpText:
        'Read from the .mcp.json in the repository root. The forms are the same as on ' +
        'the user level, but a project server has no connection check (health).',
      sPerms: 'The project’s permissions',
      sPermsText:
        'The list of patterns from .claude/settings.json: in the frame Bash(pnpm test:*) ' +
        'is allowed, Edit(migrations/**) denied, Bash(git push:*) asks. An entry marked ' +
        '«personal» goes to .claude/settings.local.json, which is usually not committed.',
      sForeign: 'The same project under another CLI',
      sForeignText:
        'The registry is shared, and the tabs are named after the active CLI’s files: ' +
        'for Codex that is AGENTS.md and .codex/config.toml. The banner says plainly ' +
        'that foreign CLIs are experimental, and the line under the editor names which ' +
        'CLI has to be restarted.',

      localTitle: 'Path two: the repository already has its own .claude',
      localCaption:
        'People come here not to configure but to understand what Claude Code will pick ' +
        'up from someone else’s repository on top of their personal set — and why no ' +
        'toggle switches it off.',
      lTab: 'The «From the project» tab as a whole',
      lTabText:
        'Three blocks and a «read-only» mark: 2 skills, 2 hooks and 2 rule files in the ' +
        'frame. Claude Code loads them together with the user-level ones; the panel only shows them.',
      lSkills: 'The repository’s skills',
      lSkillsText:
        'Name, description and the number of files in the skill’s folder. A disabled ' +
        'skill is listed too — it lives in .claude/skills-disabled and is marked ' +
        '«disabled»; it cannot be enabled from here.',
      lHooks: 'The repository’s hooks',
      lHooksText:
        'Event, matcher and command. A hook from .claude/settings.local.json is marked ' +
        'with its file name, and a reference to a script that is not on disk gets a ' +
        '«script not found» mark: such things are not left to be discovered silently.',
      lRules: 'The repository’s rule files',
      lRulesText:
        'Read recursively, .claude/rules/**/*.md: a nested folder shows in the file path ' +
        '(release/commits.md in the frame). Under the heading are the path globs the ' +
        'rule is bound to, and the text opens with the button next to the heading.',

      shotsTitle: 'The frames are real',
      shotsText:
        'Every screenshot is taken from a running panel on a separate stand with a ' +
        'throwaway settings directory: only the server’s answers are stubbed — the ' +
        'layout and the labels are the ones you get. The «Shop storefront» project and ' +
        'the C:/work/… paths are invented so that nothing from a real machine gets into a frame.',
    },

    storageRegistry: 'The project registry',
    storageRules: 'Rules',
    storageMcp: 'MCP servers',
    storagePerms: 'Permissions',
    storageLocal: 'The «From the project» tab',
    storageLocalValue: 'skills, hooks and rule files from the repository’s .claude — read-only',
    storageBackup: 'Backups',
    storageCreate: 'The .claude directory',
    storageCreateValue: 'created on the first write if the project does not have it yet',

    canRegister: 'Open any folder on the machine as a project, by absolute path',
    canRules: 'Edit the project’s CLAUDE.md as a whole, with a backup before the write',
    canMcp: 'Manage the project’s MCP servers in its .mcp.json',
    canPerms:
      'Configure the project’s permissions in .claude/settings.json and settings.local.json',
    canLocal: 'See the project’s own set — skills, hooks and rules from its .claude',
    canForeign: 'Work with the same registry under another CLI — in ITS project files',
    canAdditive: 'Work with a project without touching the user level',
    canForget: 'Drop a project from the list without touching a single one of its files',

    cantGroups:
      'Switch project rules, skills or hooks off: there are no toggles and no groups here',
    cantSandbox: 'Run a project’s set in the sandbox — it exists on the user level only',
    cantLocalEdit: 'Edit the repository’s .claude: it belongs to the project’s git',
    cantHealth:
      'Check the connection to a project’s MCP server — health is available on the user level only',
    cantGit:
      'Commit or branch from right here: git lives in the bar above a project’s chat, and ' +
      'merging the panel does nowhere',

    fieldsTitle: 'Fields',
    fieldPath: 'The absolute path to the project directory',
    fieldName: 'A short project name — the last path segment by default',

    limitsTitle: 'Boundaries and numbers',
    limitsCaption: 'The things people come back for and look up with their eyes, not by reading.',
    limitLevel: 'Scope',
    limitLevelValue:
      'one directory. The settings apply when the agent works in it or in a folder below it',
    limitTabs: 'Tabs under Claude',
    limitTabsValue:
      'four: Rules, MCP servers, Permissions, From the project. Another CLI gets only ' +
      'the ones it supports; none of them has «From the project»',
    limitReadOnly: 'Read-only',
    limitReadOnlyValue:
      'the whole .claude of the repository: skills, hooks and rule files. Changes go ' +
      'through the editor and a commit',
    limitCreate: 'The first write',
    limitCreateValue:
      'creates .claude if it was not there. Empty tabs before that are normal, not a loss',
    limitBackup: 'Backup before a write',
    limitBackupValue:
      'every save, named project-<id>-<file>: a project’s copies never mix with the ' +
      'copies of your personal files',
    limitApply: 'When it applies',
    limitApplyValue: 'at the CLI’s next start. An open session reads the files once, at startup',

    notesTitle: 'Things that trip people up',
    noteRawTitle: 'The project level is simpler than the user level',
    noteRawText:
      'Here you edit a project’s rules, MCP servers and permissions. Groups, ' +
      'soft-disable, the health check, OAuth and the sandbox do not exist on the project ' +
      'level — not as a temporary gap but as the difference between the levels: project ' +
      'files belong to the repository.',
    noteLocalTitle: '«From the project» is read-only',
    noteLocalText:
      'The panel shows the skills, hooks and rules from the project’s .claude but does ' +
      'not edit them: they belong to the project’s git and change there — in the editor ' +
      'and by commit, like the rest of the code. That is why the tab has no toggles or ' +
      'forms, and a hook from settings.local.json is marked with the file name. Rule files ' +
      'are read recursively — .claude/rules/**/*.md, a nested folder shows in the file path; ' +
      'a disabled skill from .claude/skills-disabled is listed too, marked “disabled”.',
    noteWriteTitle: 'You are editing someone else’s working tree',
    noteWriteText:
      'A save changes the repository’s file right now. If work is going on there or an ' +
      'editor is open, everyone will see the change — the panel asks nothing about ' +
      'branches and makes no commit. The backup stays with the panel and never reaches git.',
    noteUserTitle: 'The user level is separate',
    noteUserText:
      'The Rules, MCP and Permissions sections still manage ~/.claude. The project ' +
      'level does not replace them, it complements them: the agent gets both sets at once.',
    noteProviderTitle: 'Another provider means its own project files',
    noteProviderText:
      'Everything above describes Claude. With another CLI active the project registry ' +
      'is the same, but you edit ITS project files: project instructions (AGENTS.md for ' +
      'Codex and OpenCode, GEMINI.md for Gemini) and the project’s MCP servers ' +
      '(.codex/config.toml, .gemini/settings.json, .qwen/settings.json, opencode.json, ' +
      '.cursor/mcp.json, .continue/mcpServers/mcp.json). ' +
      'Gemini and Qwen Code (QWEN.md) add the project’s environment variables ' +
      '(.gemini/.env and .qwen/.env) and the project’s permissions; ' +
      'OpenCode adds the project’s permissions in the same opencode.json (the permission ' +
      'key). Aider’s project level is the .aider.conf.yml in the repository root: the read list ' +
      'of attached files and the set-env variables. Instead of a project instructions file ' +
      'Cursor gets the rules directory <project>/.cursor/rules/*.mdc — the same one as ' +
      'globally, with the same path safety. For Continue the project level is the only ' +
      'one it has: the rules directory <project>/.continue/rules/*.md, the MCP file ' +
      '.continue/mcpServers/mcp.json and the .continue/.env variables. Goose’s project level ' +
      'is a single <project>/.goosehints file next to the global one. Kimi Code gets ' +
      'AGENTS.md and the MCP file <project>/.kimi-code/mcp.json in the project; it has no ' +
      'project permissions, since the CLI reads exactly one user-level config.toml. Project ' +
      'hooks are not Claude’s alone: Qwen Code keeps them in that same ' +
      '<project>/.qwen/settings.json and they are edited from here, OpenCode keeps them in ' +
      '<project>/opencode.json but read-only — the key is gone from its schema, and the ' +
      'panel will not write what the schema does not have. Project skills exist for Qwen ' +
      'Code, Kimi Code and OpenCode, project plugins for OpenCode; each of those levels has ' +
      'a tab of its own.',

    undoTitle: 'How to put it back',
    undoCaption: 'One case per line — undo is looked up after the fact, not before.',
    undoEdit: 'An edit to a project file',
    undoEditText:
      '«Discard changes» returns the field to what is on disk, as long as you have not ' +
      'saved. After a save — the backup in «Change history», or a git checkout of that ' +
      'file: it is an ordinary repository file after all.',
    undoRemove: 'A project dropped from the list',
    undoRemoveText:
      'Add the folder again: only the panel’s record was deleted, the files stayed. The ' +
      'name, if you changed it, has to be set again.',
    undoLocal: 'Something is wrong in the repository’s .claude',
    undoLocalText:
      'There is nothing to undo here: the panel never wrote there. That is a change in ' +
      'git, and git is what reverts it.',
    undoProvider: 'Saved into the wrong file',
    undoProviderText:
      'That happens with a foreign CLI active: the tab is named AGENTS.md while you ' +
      'expected CLAUDE.md. Switch the provider back in Settings → Providers and move the ' +
      'text over — the files are not linked to each other.',
  },

  shots: {
    setup: {
      '01-empty': 'The empty registry: no projects, and the panel names what will appear here',
      '02-picker':
        'The server’s folder browser: drives, the C:/work directories and «Open this folder» at the bottom',
      '03-rules':
        'The project’s whole CLAUDE.md: 307 characters, «Discard changes» and the restart reminder',
      '04-mcp':
        'The project’s MCP servers from its .mcp.json: stdio catalog-mock and http design-mocks',
      '05-permissions':
        'Project permissions: pnpm test allowed, editing migrations denied, git push asks',
      '06-foreign':
        'The same project with Codex active: the AGENTS.md and «MCP servers» tabs, restart — Codex CLI',
    },
    local: {
      '01-tab': 'The «From the project» tab: the read-only mark, 2 skills, 2 hooks, 2 rule files',
      '02-skills':
        'The repository’s skills: release-notes with two files and a disabled legacy-import',
      '03-hooks':
        'The repository’s hooks: PreToolUse · Bash and a Stop from settings.local.json marked «script not found»',
      '04-rules':
        'Rule files: the src/**/*.tsx glob on the first and the nested release/commits.md path on the second',
    },
  },

  diagrams: {
    'registry-and-files':
      'What «add a project» does to disk: the record goes into the panel’s state, the files change only on save, and the repository’s own .claude is merely shown.',
    'other-cli':
      'One registry, different files: for Claude that is CLAUDE.md, .mcp.json and .claude/settings.json, for another CLI its own — and there is no link between them.',
  },
};
