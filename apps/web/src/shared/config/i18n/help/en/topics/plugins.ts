import type { pluginsRu } from '../../ru/topics/plugins';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const pluginsEn: typeof pluginsRu = {
  topic: {
    title: 'Plugins',
    summary: 'Ready-made bundles of skills, hooks and servers from community catalogues',
    lead:
      'A plugin is a bundle of settings someone else put together: usually skills, ' +
      'hooks and MCP servers for one particular job. Everywhere else in the panel ' +
      'you configure things yourself; here you take something ready. The section ' +
      'works differently from its neighbours: the panel does not edit files but ' +
      'calls the standard Claude Code commands and shows their output as is.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why plugins exist and how this section differs from the rest. Then a ' +
      'diagram of what happens on installation, and two paths in screenshots: ' +
      "installing someone else's plugin and scaffolding your own. At the end — the " +
      'fields, the limits and how to undo.',

    whyReady: 'Ready-made instead of hand-rolled',
    whyReadyText:
      'A bundle for a job — working with a particular framework, say — is already ' +
      'assembled and tested. You never have to work out which skills and hooks it needs.',
    whyUpdate: 'Updated with one button',
    whyUpdateText:
      'The author releases a new version, you press update. Your own configuration ' +
      'cannot do that: it has to be carried over by hand.',
    whyOfficial: 'Through the standard mechanism',
    whyOfficialText:
      'The panel invents no installation of its own; it runs the same commands you would ' +
      'in the terminal. What is installed behaves the same in both.',

    diffTitle: 'The one section that does not write files',
    diffCaption:
      'In every other section nothing stands between the button and the disk. Here ' +
      'something does — and almost every quirk of the section grows from that.',
    diffCli: 'It only works with the CLI installed',
    diffCliText:
      'With no claude in the PATH of the panel process nothing here works, and the ' +
      'section says so in a line. The other sections carry on as usual in the same ' +
      'situation.',
    diffOutput: 'The CLI explains the error, not the panel',
    diffOutputText:
      'The command output is shown in full and unrewritten: it is the only source ' +
      'of truth about what went wrong.',
    diffOwn: "A plugin's contents belong to someone else",
    diffOwnText:
      "A plugin's skills and hooks show up in their own sections but belong to the " +
      'author: an update would overwrite any edit, which is why the panel does not ' +
      'edit them.',

    guide: {
      mapTitle: 'What happens on installation',
      mapCaption:
        'The diagram explains three things at once: why the CLI has to be ' +
        'installed, why a plugin does not work until a restart, and why the panel ' +
        'sometimes shows a plugin whose folder is already gone from disk.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'A button in the panel launches the claude plugin command — the same one you ' +
        'would type in the terminal. The CLI reaches the marketplace (usually a ' +
        'GitHub repository), puts the plugin into a directory on disk and records it ' +
        'in installed_plugins.json; a plugin counts as enabled when the registry ' +
        'explicitly says yes. The panel reads that registry itself and understands ' +
        "version 2 only — exactly the one the CLI reads. The plugin's skills, hooks " +
        'and servers are picked up on the next session start, not immediately.',

      installTitle: "Installing someone else's plugin",
      installCaption:
        'The first way in. What is already installed, the catalogue of sources, ' +
        'installation by identifier and removing a whole marketplace.',
      iInstalled: 'What is already installed',
      iInstalledText:
        'Three plugins, and two of them have something to say beyond a version: ' +
        'sql-helper 0.9.2 is switched off — its commands and skills do not work, but ' +
        'it stays on disk; docs-kit 2.0.1 is marked "folder missing" — the CLI counts ' +
        'it as installed while the folder is gone. Without the mark such a plugin ' +
        'would look fine.',
      iCatalog: 'The catalogue loads on a button',
      iCatalogText:
        'Behind it the CLI updates repositories and reaches the network, so it does ' +
        'not open by itself. Search covers the marketplace name too — "whose plugin ' +
        'is this" is as much a question as "what does it do": the query lab left 3 ' +
        'entries out of 4, with install counts from 310 to 2 thousand.',
      iInstall: "Installation shows the command's answer",
      iInstallText:
        'Installing by identifier is collapsed and sits after the catalogue on ' +
        "purpose: check the list first. The error is shown in the CLI's own words — " +
        'here it spells out which plugins that marketplace actually has.',
      iMarketplace: 'Removing a source states the consequences',
      iMarketplaceText:
        'When Claude Code removes a marketplace it drops every plugin from it — with ' +
        'no question of its own. The panel asks for confirmation and lists by name ' +
        'what goes with team-tools: code-review and sql-helper.',

      ownTitle: 'Scaffolding your own plugin',
      ownCaption:
        'The second way in. The panel neither publishes a plugin nor installs it — ' +
        'it writes a scaffold in the Claude Code format into a folder you choose.',
      oNoCli: 'The CLI did not answer — the reason is named',
      oNoCliText:
        'The list is empty not because there are no plugins: the line says claude was ' +
        'not found in the PATH of the panel process. A silent zero would send someone ' +
        'hunting for missing commands in the wrong place.',
      oScaffold: 'The scaffold is assembled with checkboxes',
      oScaffoldText:
        'Name, description, author and the target folder, picked by browsing the ' +
        'disk. The manifest and the README are always written, the rest is optional: ' +
        'empty folders only get in the way.',
      oCreated: 'What appeared on disk',
      oCreatedText:
        'The server answers with a path and a list of files, and the card shows ' +
        'exactly those: the manifest .claude-plugin/plugin.json, README.md, a sample ' +
        'command commands/example.md and the SKILL.md of the ticked skill. From here ' +
        'the plugin is refined as ordinary files.',

      shotsTitle: 'Screenshots: the one substitution in the whole configuration guide',
      shotsText:
        'The section asks the installed claude, so a frame would depend on the ' +
        'plugins of the machine it was shot on and on a trip to the network. The ' +
        "CLI's ANSWER is substituted; the layout, the counters and the dialogs are " +
        'real. Disk browsing is substituted for the same reason — it would show ' +
        "someone's real directories. Re-shot with node tools/help-shots/config-panel.mjs.",
    },

    canCatalog: 'Browse the catalogue of available plugins and search it',
    canInstall: 'Install a plugin from the catalogue or by identifier by hand',
    canUpdate: 'Update an installed plugin to a new version',
    canToggle: 'Switch a plugin off without removing it',
    canUninstall: 'Remove an installed plugin',
    canMarketplaces: 'Add and remove marketplace sources right from the panel and see their list',
    canSee: 'See where a plugin came from and when it was last updated',
    canView: 'Inspect the contents of an installed plugin — its skills, hooks and servers',
    canScaffold: 'Scaffold your own plugin and go on refining it in files',

    cantEdit: 'Edit the contents of an installed plugin: its skills and hooks belong to the author',
    cantPick: 'Take only part of a plugin — it installs whole',
    cantOffline: 'Work offline: both the catalogue and installation reach the source',
    cantNoCli: 'Do anything at all without claude installed — the whole section leans on it',
    cantPublish:
      'Publish the scaffold you built: the panel writes files, the marketplace is yours to set up',

    storageWhere: 'Who is in charge',
    storageWhereValue: 'the claude plugin commands — the panel calls them and touches no files',
    storageId: 'Identifier',
    storageIdValue:
      'name@marketplace — plugins with the same name from different sources stay distinct',
    storageSource: 'Source',
    storageSourceValue: 'a marketplace, usually a GitHub repository',
    storageResult: 'What the panel shows',
    storageResultValue: 'the command output as is — the only source of truth about a failure',

    noteMarketplaceTitle: 'Removing a marketplace takes its plugins with it',
    noteMarketplaceText:
      'When a source is removed, Claude Code drops every plugin installed from it — with ' +
      'no question of its own. The panel asks first and lists exactly what goes. A plugin ' +
      'whose folder vanished from disk is still "installed" to the CLI: the card marks it ' +
      '"folder missing".',
    noteProviderTitle: "Other providers' plugins are their own",
    noteProviderText:
      "Everything described here is about Claude Code's plugins and marketplaces. With " +
      'the OpenCode provider the section opens a different screen: there it is about ' +
      'plugins of the CLI itself, and there are two ways to attach one. First, drop a JS ' +
      'or TS file into the plugins directory (global ~/.config/opencode/plugins/, ' +
      'per-project <project>/.opencode/plugins/): everything there is loaded by OpenCode ' +
      'at startup, and the panel manages those files as a plain file manager — create, ' +
      'open, edit, delete. Second, list npm package names under the plugin key of ' +
      'opencode.json; both plain and scoped packages such as @org/name are supported. ' +
      'The panel cannot install packages — the CLI does that, it only edits the list. ' +
      'OpenCode has no catalogue, no marketplaces and no one-click update. ' +
      'With the Kimi Code provider the section is read-only: the panel reads the ' +
      '~/.kimi-code/plugins/managed/ directory and each plugin’s manifest and lists them — ' +
      'name, version, description and what the plugin brings (skills, a session-start ' +
      'skill, MCP servers, how many hooks it declares, whether it has commands). ' +
      'Installing, enabling and disabling happen in the CLI itself via /plugins: the shape ' +
      'of its installed.json registry is undocumented, and editing that state behind its ' +
      'back would be guesswork, so a write is refused.',

    flowTitle: 'What happens on installation',
    flowCaption:
      'This is exactly where the section differs from the others: Claude Code stands ' +
      'between the panel and the files. So the result is reported in its words.',
    flowClick: 'A button in the panel',
    flowClickCaption: 'install or update',
    flowCli: 'claude plugin',
    flowCliCaption: 'the standard command',
    flowFetch: 'Fetched from the marketplace',
    flowFetchCaption: 'usually a repository',
    flowReady: 'The plugin is installed',
    flowReadyCaption: 'it works after a restart',

    fieldsTitle: 'What a plugin shows',
    fieldsCaption:
      'There are no creation forms here: apart from installing and the scaffold, it is read only.',
    fieldId: 'An identifier of the form name@marketplace. Used for manual installation.',
    fieldMarketplace: 'The source the plugin came from.',
    fieldVersion: 'The installed version.',
    fieldScope: 'The scope the plugin applies to.',
    fieldInstalled: 'When it was installed and when it was last updated.',
    fieldCount: 'How many times the plugin has been installed. Catalogue entries only.',

    scaffoldTitle: 'A scaffold for your own plugin',
    scaffoldCaption:
      'The one place in the section where the panel writes files itself — and it ' +
      'writes them into your folder, not into the config directory.',
    scaffoldManifest: 'Manifest and README',
    scaffoldManifestText:
      'Always written: .claude-plugin/plugin.json with the name, version, description ' +
      'and author, plus README.md. Without a manifest Claude Code does not treat the ' +
      'folder as a plugin.',
    scaffoldParts: 'Optional parts',
    scaffoldPartsText:
      'Commands, agents, skills and hooks are added with checkboxes, each with a ' +
      'working example inside. What is not ticked is not created: empty folders only ' +
      'get in the way.',
    scaffoldNext: 'What comes next',
    scaffoldNextText:
      'The panel stops there: it neither publishes the plugin nor sets up a ' +
      'marketplace. From here the folder is refined as ordinary files and pushed to a ' +
      'repository.',

    limitsTitle: 'The limits of the section',
    limitsCaption:
      'The conditions people trip over most. Everything listed here is visible in ' +
      'the frames above.',
    limitCli: 'Dependence on the CLI',
    limitCliValue:
      'total: without claude in the PATH of the panel process not a single action of the ' +
      'section works',
    limitRegistry: 'Registry',
    limitRegistryValue:
      'installed_plugins.json version 2 only — the one the CLI itself reads; a plugin counts ' +
      'as enabled when the registry explicitly says yes',
    limitSerial: 'Concurrency',
    limitSerialValue:
      'operations run one at a time: while a command works, the buttons on the whole page ' +
      'are disabled',
    limitSlow: 'Slow commands',
    limitSlowValue:
      'the list of installed plugins is waited on for up to a minute, the catalogue of ' +
      'available ones for up to three: it reaches the network and updates repositories',
    limitWrite: 'What the panel writes itself',
    limitWriteValue:
      'only the scaffold of a new plugin, and only into the folder you chose. It never ' +
      'writes into the directories of installed plugins',
    limitApply: 'When it takes effect',
    limitApplyValue:
      "a plugin's skills, hooks and servers are picked up on the next session start, not at once",

    recipesTitle: 'Installing a plugin',
    recipe1: 'Open the catalogue',
    recipe1Text:
      'It loads on a button rather than up front: there are several hundred entries and ' +
      'no reason to fetch them on every visit.',
    recipe2: 'Find what you need with search',
    recipe2Text: 'Search covers the name, the marketplace and the description.',
    recipe3: 'Install it and read the output',
    recipe3Text:
      'The panel shows the command’s answer in full. If something went wrong, the reason ' +
      'is written there rather than in the panel interface.',
    recipe4: 'Restart Claude Code',
    recipe4Text: 'The plugin’s skills and hooks are picked up on the next start.',

    undoTitle: 'How to undo',
    undoCaption:
      'There is no single undo button here: the CLI owns the files. Every step is ' +
      'reversible by its own command, though — from the gentlest to the bluntest.',
    undoToggle: 'Switch it off instead of removing it',
    undoToggleText:
      'The plugin stays on disk and in the list marked "off", while its commands and ' +
      'skills stop working. A way to check "is it the plugin?" without losing anything.',
    undoUninstall: 'Remove the plugin',
    undoUninstallText:
      'That takes out one plugin while the source stays: it can be installed again ' +
      'from the same catalogue, with the same identifier.',
    undoMarketplace: 'Bring the source back',
    undoMarketplaceText:
      'A removed marketplace is added back with the same button, but its plugins have ' +
      'to be installed again: the CLI took them out along with the source.',
    undoScaffold: 'Remove the scaffold',
    undoScaffoldText:
      'The folder created is ordinary files in your directory, registered nowhere. It ' +
      'is deleted like any other folder, and installed plugins are unaffected.',

    notesTitle: 'Things people trip over',
    noteCliTitle: 'This section depends on the CLI',
    noteCliText:
      'If claude is not found on the system, nothing here works — unlike the other ' +
      'sections, which edit files directly. The reason is stated in a line rather than ' +
      'shown as an empty list.',
    noteSlowTitle: 'Installation can take a while',
    noteSlowText:
      'The command reaches the network and may take minutes. The panel waits for it ' +
      'and shows the result when it arrives. While any operation runs, the buttons on ' +
      'the whole page are disabled — plugin commands cannot be interleaved.',
    noteContentTitle: 'Plugin contents do not show up as yours in other sections',
    noteContentText:
      'A plugin’s skills and hooks belong to it. Editing them through the panel is not ' +
      'possible — an update from the author would overwrite the changes anyway.',
    noteManualTitle: 'Manual installation is tucked away on purpose',
    noteManualText:
      'Installing by identifier is collapsed and sits after the catalogue: it is worth ' +
      'checking the list first.',
    noteMissingTitle: 'A plugin with no folder on disk stays in the list',
    noteMissingText:
      'The CLI counts it as installed as long as the registry has the entry — even ' +
      'with the folder gone. The panel sees that and marks the card "folder missing": ' +
      'otherwise the plugin would look fine while its commands silently failed to ' +
      'appear in the palette.',
  },

  shots: {
    install: {
      '01-installed': 'Three installed: one switched off, another with its folder gone from disk',
      '02-catalog': 'The catalogue loads on a button; search covers the marketplace name too',
      '03-install': 'The CLI explains the error — the panel shows its output in full',
      '04-marketplace': 'Removing a source lists by name which plugins go with it',
    },
    own: {
      '01-no-cli': 'The CLI was not found: the reason is stated, not shown as an empty list',
      '02-scaffold': 'The scaffold is assembled with checkboxes; manifest and README always go in',
      '03-created': 'The panel answers with a path and a list of the files created',
    },
  },

  diagrams: {
    'plugin-install':
      'The installation path: a panel button → the standard claude plugin command → the marketplace → a directory on disk and an entry in the version 2 registry. That is why the CLI has to be installed and why the plugin only works from the next session.',
  },
};
