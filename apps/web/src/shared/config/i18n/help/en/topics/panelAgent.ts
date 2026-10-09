import type { panelAgentRu } from '../../ru/topics/panelAgent';

/** Typed against the Russian module: a key forgotten in translation fails the build. */
export const panelAgentEn: typeof panelAgentRu = {
  topic: {
    title: 'Panel agent',
    summary:
      'A window where the panel is driven by words: the agent asks for an action, the panel ' +
      'shows a card and runs it only after your click',
    lead:
      'The «Panel agent» button is on every page. You type or dictate in plain words — «add a ' +
      'project», «connect a contour», «delete a rule», «how do I set up a hook?» — and the ' +
      'agent answers from the panel help or does it with the same actions the section buttons ' +
      'use. It writes nothing on its own: every action that changes something arrives as a ' +
      'card showing what will be written and waits for your «Run» — in the window on the ' +
      'computer or in the phone app. The agent never receives keys or secrets — you enter ' +
      'them in the panel’s own fields.',
    guideTitle: 'How this page is organised',
    guideText:
      'First the diagram: the path of one action from your message to the file on disk. Then ' +
      'two paths in real screenshots — «I want the panel to do this» and «the agent refused ' +
      'or did not do something». After them — how to ask «how do I», the actions of every ' +
      'section, the confirmation card, the route, files, limits and refusals.',
    askTitle: 'Ask how to do something',
    askCaption:
      'The agent reads the same help you do — and answers from it, not from the model’s ' +
      'memory',
    askHow: '«How do I…?» — an answer from help',
    askHowText:
      '«How do I set up a hook on Bash?» — the agent searches the panel help, reads the topic ' +
      'it found and answers with its steps, naming the topic. This is reading: no cards, ' +
      'nothing changes.',
    askDo: '«Do…» — an action with a card',
    askDoText:
      'Ask for the same thing in words — the agent does it with an action from the list ' +
      'below, and everything that changes arrives as a card.',
    askNot: 'Not in help — it says so',
    askNotText:
      'If no help topic answers the question, the agent says so instead of inventing a button ' +
      'the panel does not have.',
    linksTitle: 'How the agent links the sections',
    linkCaption:
      'The agent receives this section word for word from the first message of a conversation — ' +
      'this is how it reasons when a request touches several sections',
    linkTableName: 'Link',
    linkTableWhat: 'How the agent handles it',
    linksMap: 'The whole panel is one map',
    linksMapText:
      'From the first word the agent knows every help topic by title and summary, and reads the ' +
      'right topic in full before answering. A request that touches several sections is split ' +
      'across them: each part is answered by the section that owns it.',
    linksChat: 'Code in chat, settings here',
    linksChatText:
      'Editing code, a presentation, a picture — that is chat work. The agent does not do it ' +
      'itself: it offers, as a card, a chat in a project from «Projects» (or with no project), ' +
      'and chat takes over.',
    linksConfig: 'One setting, two levels',
    linksConfigText:
      'Rules, skills, hooks, MCP servers, permissions and environment exist for every project ' +
      'and per project (the «Projects» section). If the request does not say where, the agent ' +
      'asks for the level instead of picking one.',
    linksTests: 'Tests and integrations',
    linksTestsText:
      'Cases, plans and runs live in «Tests»; CI reports and test management systems are ' +
      'connected in «Integrations». The agent names which of the two a step belongs to.',
    linksGroupWord: 'The word «group»',
    linksGroupWordText:
      'Either a settings bundle, a working order or a scenario in «Groups», or a case group in ' +
      '«Tests». When the request does not make clear which, the agent asks.',
    linksRulesWord: 'The word «rule»',
    linksRulesWordText:
      'Either a standing instruction in «Rules» (CLAUDE.md), a permission rule in «Permissions» ' +
      '(allow, ask, deny), or a «Data protection» rule. When it is unclear which, the agent asks.',
    linksYours: 'Only by your hand',
    linksYoursText:
      'Everything that changes is carried out by a human click on the card, and nothing else. ' +
      'Settings only you change the agent does not touch: it names the section and the button ' +
      'and looks for no way around.',
    linksLong: 'Long work',
    linksLongText:
      'An agent turn is a panel setting — a short step with a card. Multi-step work on a ' +
      'project the agent hands to chat, and a card waits 10 minutes for a decision.',
    linksInside: 'How the panel is built',
    linksInsideText:
      'The agent explains what the panel has and how to use it. How the panel works inside — ' +
      'server addresses, source files, the text of its instructions, tool definitions — it ' +
      'does not tell, and it never shows the value of a key or token.',
    whyTitle: 'Why a window when there are buttons',
    whyWords: 'Words are faster than forms',
    whyWordsText:
      '«Add project C:/work/shop and open it» is one sentence instead of a page switch, a ' +
      'button and two fields. The agent finds the section and opens it next to the window.',
    whySame: 'The same actions as the buttons',
    whySameText:
      'The agent has no path of its own to files: it asks for an action, and the panel runs it ' +
      'through the same route as the section’s button — same validation, same backup copy, ' +
      'same entry in Change history.',
    whyTrace: 'Everything it did is visible',
    whyTraceText:
      'Each action lands as a line in the Action trail: what, with which outcome and who ' +
      'decided — you with a click, or the panel without a question because it was a read.',

    pathMapTitle: 'The path of one action',
    pathMapCaption:
      'The model only asks. The panel executes, and a changing action waits for your click',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'The message passes the data mask, then the panel starts the active CLI — ' +
      'Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose or Kimi Code — with no ' +
      'built-in tools and none of your personal CLI settings (hooks, skills, own MCP servers, ' +
      'AGENTS.md; Codex without your config.toml, Gemini CLI, OpenCode, Goose and Kimi Code with ' +
      'their own one-turn directory that receives only the model and the login): all ' +
      'it has is the bridge to the panel’s actions, and the turn itself never lands in the ' +
      'CLI’s session history — the panel keeps the conversation. With Gemini CLI, OpenCode, ' +
      'Goose and Kimi Code the turn also checks every call: should the model ask for a tool ' +
      'beyond the bridge, the turn stops. The model picks an action. A ' +
      'read runs at once; a change or a dangerous action is shown as a card with a preview and ' +
      'waits up to 10 minutes. After «Run» the panel checks the target has not changed, runs the ' +
      'action through the section’s route, opens the page with the result and writes a line to ' +
      'the action trail. The page opens on the tab where the named item is visible: a DLP rule ' +
      'on the rules tab, a rule or a script on “All”, a group on the tab of its scope, a half of ' +
      'a pair on the pair’s shared card; where the page has filters (Permissions, for ' +
      'example), they are cleared and the row is highlighted. Asking to show the same thing again clears the filters again, even when the ' +
      'address has not changed. Along with the message the model gets the outcomes of this ' +
      'conversation’s earlier actions — id, name, refusal — so «open that chat» needs no ' +
      're-reading of lists. All its text reaches the feed as it is, so a working note in Latin ' +
      'script before an action call in a Russian conversation is not shown; if the turn ends ' +
      'after such a note, it is the answer, and it is shown.',

    keysMapTitle: 'Keys and files',
    keysMapCaption: 'What the agent never receives and what it leaves on disk',

    actionsTitle: 'What the agent can do — by section',
    actionsCaption:
      'Exactly this list — every panel section, nothing more. The risk class decides whether ' +
      'the panel asks: read — no question, change — a card focused on «Run», danger — focused ' +
      'on «Reject»',
    actionsSection: 'Section',
    actionsWhat: 'Actions and risk class',
    riskRead: 'read',
    riskChange: 'change',
    riskDanger: 'dangerous',
    secNavigation: 'Navigation',
    secNavigationText:
      'Where am I, list sections, open a page, overview, panel search, analytics summary, ' +
      'provider comparison, the environment passport of any installed CLI — read; the ' +
      'passport never carries secret values. Long lists (search, history, backups, plugins, ' +
      'comparison) are read page by page with the total known; a read with no answer for 4 ' +
      'minutes ends in an honest refusal. A changing action opens the section with the result ' +
      'by itself — on the created or renamed item; after a question or a read the agent never ' +
      'moves your screen. Only the window of the conversation that ran the action opens the ' +
      'page — another tab stays put. Results of earlier turns (a new id, a started chat) are ' +
      'remembered within the conversation until the panel restarts.',
    secProjects: 'Projects and chats',
    secProjectsText:
      'Projects, chats, running runs, git state and worktrees — read; ' +
      'the chats of a project include those in its worktrees, as in the project tab. ' +
      'Add a project — change; ' +
      'afterwards that project opens, and «and open its chat» opens the project tab in chat. ' +
      'Remove a project from the registry and start a chat with a task — danger: the chat ' +
      'card shows the whole prompt, the run spends the limit. A presentation, a picture or a ' +
      'plain question needs no project: the agent starts a chat without one in «Presentation», ' +
      '«Image» or «Message» mode and never registers a folder just for a chat. If the CLI ' +
      'refuses before the session starts, the action fails with its reason and no empty chat ' +
      'opens. Git status and the list of copies are read only for panel projects and their git ' +
      'copies.',
    secRules: 'Rules',
    secRulesText:
      'List — read. Save a rule and switch it on/off — change, with a CLAUDE.md diff. Delete — ' +
      'dangerous.',
    secSkills: 'Skills',
    secSkillsText:
      'List and the text of one skill (SKILL.md, secrets masked) — read. Save a skill — change. ' +
      'Delete a skill folder — dangerous. Files inside a skill folder and structure templates — ' +
      'read; renaming a skill, writing or moving a module file, adding a template (missing ' +
      'files only) — change, with a diff; deleting a module file — dangerous, SKILL.md itself ' +
      'is not deleted this way.',
    secHooks: 'Hooks',
    secHooksText:
      'List — read. Write and enable/disable a hook — change, with the settings.json diff. ' +
      'Delete — danger. A hook is a command Claude Code runs by itself: read it in full on ' +
      'the card. Moving a hook one place up or down among the hooks of the same event — ' +
      'change; the card shows the order before and after.',
    secEnv: 'Environment variables',
    secEnvText:
      'List — read, secret values hidden. Write a variable — change; a secret one is written ' +
      'without a value, and the panel opens the value field for you. Delete — danger. Moving ' +
      'a variable between settings.json and settings.local.json — change; the value moves as ' +
      'it is, the agent never sees it.',
    secClaudeMd: 'CLAUDE.md',
    secClaudeMdText:
      'Read the file — read. Rewrite it whole — danger, with a diff; a single rule goes ' +
      'through «Rules».',
    secScripts: 'Scripts and commands',
    secScriptsText:
      'Commands, scripts and a script’s text — read. Write a script — change. Delete — ' +
      'danger.',
    secGroups: 'Groups',
    secGroupsText:
      'List — read: the agent sees the group’s variables too, secret ones masked, a disabled ' +
      'group’s included. So it can add a variable without wiping the others: a mask is written ' +
      'back as the value already on disk. Write and enable/disable a group — change. Delete — danger; ' +
      'the delete card names the variables that leave settings.json and the members, switched off by ' +
      'this group alone, that come back on. Explaining one group is a read too: what each member ' +
      'does (a line from its own file), the «Path» in order and the skill knobs — «Auto» or ' +
      'pinned. Changes, each through a card: a draft of a new group from your description ' +
      '(members, «When», own path steps and knobs in one card; the group is created switched ' +
      'off), an own path step — add or reorder, knobs — pin or return to «Auto». A scenario — ' +
      'a group whose ordered steps ARE the whole work, with no pipeline stages — is drafted in ' +
      'ONE card too: each step is either an existing skill (it joins as a member) or its own ' +
      'text with a title, a prompt and an optional «Done when»; the card lists the steps in ' +
      'order. A taken name or an unknown skill is refused before the card; the scenario is ' +
      'created switched off, and the «Groups» page opens on it. Groups by scope: sets found in ' +
      'projects and the catalog of ready resources — read; importing a found set (a project ' +
      'group, switched off), a new search, copying a project group to global with the model’s ' +
      'advice, applying chosen advice to the copy, merging the copy with a changed original, ' +
      'overriding a global group in a project and switching on the groups bound to a folder — ' +
      'change through a card; whatever calls the model spends your quota, and the card says so. ' +
      'A «Path» step can be drafted by the step assistant — a card with your words, since it ' +
      'calls the model; the group does not change, the assistant’s conversation is kept as with ' +
      'the button — and an own step turned into a separate skill, rule, hook or script — a card ' +
      'too, with the resource text. Overrides, activating groups by folder and the catalog work ' +
      'only for panel projects and their git copies: any other folder is refused before a card. ' +
      'A short description of a skill, hook or rule is a change: without a cached one the ' +
      'panel makes one cheap model call.',
    secPlugins: 'Plugins',
    secPluginsText:
      'Installed and available — read. Enable/disable and update — change. Install, ' +
      'uninstall, connect or disconnect a marketplace — danger: a plugin brings code that ' +
      'runs later. The install card names the marketplace address the code comes from; a ' +
      'plugin of a marketplace that is not connected and a source with spaces or shell ' +
      'characters are refused before a card. A new plugin skeleton in a new folder — change: ' +
      'manifest, README and the chosen parts; an existing folder is never overwritten.',
    secHistory: 'History and backups',
    secHistoryText:
      'Change feed, diff, backup list — read. Revert a hunk and restore a file from a backup ' +
      '— danger. Only the newest entry of a file can be reverted; the restore card shows a ' +
      '"now → will be" diff and the copy time in local time, and if the file already matches ' +
      'the copy, the agent refuses without a card. A binary file is listed on the card ' +
      'without a line diff: the restore replaces it with the copy as a whole. A change ' +
      'too large for a line diff never reaches a card: such a card could not be approved, so the ' +
      'agent refuses at once and points to restoring the copy on the History page. In a restore ' +
      'card for .mcp-secrets.env the values are replaced with labels ••••••1, ••••••2: you see ' +
      'which lines change, not the secrets themselves. Deleting a backup for good — danger: it ' +
      'can no longer be restored from.',
    secSettings: 'Settings and provider',
    secSettingsText:
      'Read settings — read. Change allowed keys — change. Switch the active CLI — danger: ' +
      'the whole panel, chat and the agent itself change. The shared group rules, the watcher, ' +
      'the model catalog page by page, the CLI format check, the account and the CLI version ' +
      'the agent reads. Changing the group rule numbers and switching the watcher on or off — ' +
      'change: the watcher spends quota in the background; afterwards the Watcher page opens. ' +
      'Group permissions and group ' +
      'questions are changed only by you. Updating the CLI — danger; the result names the ' +
      'version after the update. ' +
      'Model prices, code editors, where Claude Code’s account access comes from (the key ' +
      'itself is never returned), browsing this machine’s folders, providers and their check ' +
      'results are reads. Checking the provider is a change: writing is checked on a ' +
      'temporary copy, and the model call, if asked for, spends the limit. Pre-MR sieves — the ' +
      'ones learned from reviewer threads and the monthly blocker tally — are a read; removing ' +
      'a learned sieve is danger: it stops reaching group tasks, and only a new blocker in an ' +
      'MR can bring it back. Only you can accept a proposed sieve, with the card’s button: ' +
      'its text would become a task for every group.',
    secEndpoints: 'Own endpoints',
    secEndpointsText:
      'List and connection check — read. Write a profile — change, without a token: the panel ' +
      'opens the token field; a second profile with the same name, address and API kind is ' +
      'refused. Apply to a CLI and delete — danger. After an action the Models tab opens.',
    secIntegrations: 'Integrations',
    secIntegrationsText:
      'List — read. Connection check — change: the result is written, and a webhook gets a ' +
      'real test event. Write settings — change, without a token: the panel opens the token ' +
      'field (not for the webhook — its signing key is optional — and not when switching off); ' +
      'the address has its own row on the card; a value read masked is taken from disk. ' +
      'Disconnect and forget the token — ' +
      'danger. After an action the panel opens the Integrations tab. Jira projects and issues, ' +
      'Confluence spaces and pages the agent only reads, keys in an issue or page text masked; ' +
      'filing a defect, commenting, changing a status or publishing a page is yours. Linking a ' +
      'project or a test group to an issue, a page or a repository — change; disconnecting ' +
      'the Atlassian MCP server from the CLI — change. Connecting it is yours alone, with the ' +
      '“Connect Atlassian MCP” button: once connected, an agent writes to Jira and Confluence ' +
      'on its own. Removing a link — danger; nothing changes in Jira or Confluence. Links exist only for ' +
      'projects added to the panel. ' +
      'The transitions available to a Jira issue are a read; the transition itself is yours.',
    secDlp: 'Data protection',
    secDlpText:
      'Rules and proxy state — read. Write rules and start/stop the proxy — change; the start ' +
      'card shows where the proxy forwards requests. Without that address or without an ' +
      'enabled rule the start is refused before a card. Checking a text against the saved ' +
      'rules (what the model behind the proxy would see) and reading the proxy journal — read. ' +
      'Clearing the journal — danger: the card names the entry count, and an entry arriving ' +
      'after the card was shown makes it stale.',
    secHelp: 'Help',
    secHelpText:
      'Help search, topic list, reading a topic — read, no cards: this is how the agent ' +
      'answers «how do I». Nothing found in the panel language — the search repeats itself in ' +
      'the other help language, and the agent says which one it found the answer in.',
    secMcp: 'MCP servers',
    secMcpText:
      'List — read, with secret values hidden. Save a server — change. Delete — dangerous. ' +
      'Checking the connection and asking the server for its tools — change through a card: ' +
      'the panel runs the server’s command; the check result shows on the MCP page.',
    secPermissions: 'Permissions',
    secPermissionsText:
      'List — read: paged, with totals per decision and a filter by decision or a piece of ' +
      'the pattern. Add a permission rule — change; afterwards the list scrolls to the new ' +
      'row. Remove — dangerous. Editing a rule in place (decision and pattern, keeping its file ' +
      'and groups) and moving it to the other settings file — change.',
    secContour: 'Contour',
    secContourText:
      'Contour list, status, address probe — read. Save a draft — change, without the key. ' +
      'Enable a contour — dangerous: after it CLI requests go to the company contour. The ' +
      'gateway state and the contour spend with the «budget exhausted» mark — read. Starting ' +
      'the gateway, clearing the «budget exhausted» mark and connecting or disconnecting the ' +
      'contour MCP — change. Restarting the gateway, removing a contour’s application, ' +
      'switching it off and deleting it together with its key — danger: the card names where ' +
      'the contour is applied and what comes back. The agent never sees the contour key in ' +
      'any answer.',
    secTests: 'Testing',
    secTestsText:
      'Groups, cases, coverage, runs, case lint — read. «Open testing of project X» opens ' +
      'the section on X itself, not on the project this browser picked last. Asked «what ' +
      'failed», the agent takes ' +
      'the newest run that CHECKED cases, not a generation, and names the red cases in words, ' +
      'with the step and the note. Adding or editing a case, creating or renaming a group, ' +
      'accepting or rejecting a draft, stopping a run — change: the card shows the case before ' +
      'and after, an edit touches only the named fields. A new case from the agent is marked as ' +
      'the agent’s, like an accepted draft; an edited one keeps its author. Starting a run, a generation or a ' +
      'charter exploration, deleting a case or a whole group — danger. After a start the library ' +
      'opens: progress, log and «Stop» live there. The agent also reads the «Report» tab ' +
      '(run comparison, change impact, flaky, quarantine, risk, release), plans, the manual run, ' +
      'baselines and the e2e folder. Creating, editing or building a test plan by a rule (the ' +
      'card shows the picked cases, the plan is written only after the click), ' +
      'starting, marking, finishing or cancelling a manual run, attaching a text note to a case, ' +
      'syncing the e2e folder, stopping autotests, editing shared steps, environments, custom ' +
      'fields and statuses, saved filters, the case convention, bulk case edits and drafts ' +
      'auto-accept — change. Deleting a plan, an environment, a shared step or cases in bulk, ' +
      'accepting a snapshot as the baseline, running the project’s autotests, rolling back an ' +
      'accepted draft — danger. Environment passwords and the baseline snapshot are never set ' +
      'by the agent: the human enters them in the window. Reports, plans, the manual run, ' +
      'baselines, e2e and the library setup work only in projects added to the panel: for any ' +
      'other folder the agent is refused before a card. ' +
      'A defect draft from a case, test drafts and default groups are reads; filing the ' +
      'defect in a tracker is yours. Refreshing defect states from the tracker and creating ' +
      'the e2e folder are changes, removing the e2e folder the panel created is dangerous; ' +
      'the project’s own folder is never removed. The baseline snapshot is uploaded by you.',
    secProjectConfig: 'Project settings',
    secProjectConfigText:
      'The project instructions file, its MCP servers (secrets masked), permissions and which ' +
      'side of a group pair is active in the project — read. Turning a project MCP server on or ' +
      'off, adding or editing a permission, switching the group — change: the card shows the ' +
      'entry before and after. Adding or editing a project MCP server — danger: the CLI runs its ' +
      'command later by itself, with no card, so the card names it in full. Replacing the ' +
      'project instructions file, deleting an MCP server or a permission — danger, with the file ' +
      'diff. The agent never sends secret values: you fill an empty one on the project card. If ' +
      'you change the target while a card waits, it does not run: the agent shows a fresh one. ' +
      'The project’s (or copy’s) own .claude folder (skills, hooks, rules with their path ' +
      'masks) is a read: it belongs to the project’s git, the agent does not edit it.',
    secProjectGit: 'Project git and copies',
    secProjectGitText:
      'Copy and split settings — read. Switching or creating a branch, committing all changes, ' +
      'pulling commits, creating, removing, reinstalling or refreshing a working copy, changing ' +
      'the copy patterns and install command — danger: the card names the branch, the commit ' +
      'files and the command. Delivering groups to a merge request and how many groups run at ' +
      'once — change. Pushing a commit to the server and deciding split group permissions and ' +
      'branches are not the agent’s: it prepares everything and asks you to press the button. ' +
      'The full install log of a working copy is a read, keys in it masked.',
    secProjectRunner: 'Project dev server and code',
    secProjectRunnerText:
      'Run targets, running dev servers, the code tree and files — read, secrets in the text ' +
      'masked. Stopping a dev server — change. Starting one, changing its command or port, ' +
      'turning on autostart, freeing a port — danger: the card shows the whole command, the body ' +
      'of the package.json script it runs and the processes on the port. The agent never stops ' +
      'the panel’s ports and processes (watchdog, chats, dev servers it started) and never ' +
      'edits code files — that is the code window. ' +
      'Which files a chat’s agent changed during the conversation (+/− lines) is a read too, ' +
      'only for chats of panel projects and their copies.',
    secChatSession: 'Chat session and files',
    secChatSessionText:
      'Chat files — list and read, secrets masked. Opening a project in the editor — change, only ' +
      'with editors the panel knows. Deleting a chat file, accepting the agent’s «continue in a ' +
      'new session» proposal and «Restart session» — danger: the card shows what is done and what ' +
      'comes next, the model and the file-edit permission (off by default). The agent does not ' +
      'export a conversation to a file — it opens the chat and asks you to press «Export».',
    secSandbox: 'Sandbox',
    secSandboxText:
      'Event fixtures — read. Running a hook or script on fixtures or on your own event, and ' +
      'asking Claude with a temporary copy of the chosen rules, skills, hooks, MCP servers and ' +
      'scripts — danger: the command and the question run on this computer, the question spends ' +
      'the subscription limit. The sandbox is built for one call and removed right after it. ' +
      'Calling an MCP server tool from the sandbox stays yours: it may write to the outside.',
    secKit: 'Panel kit',
    secKitText:
      'What the kit holds — skills, commands, agents, rules and hooks, which are on, where each ' +
      'differs from the same-named item in your global layer, what exists only there, and each ' +
      "CLI's mode — read. Switching modes, editing, «To global» and «From global» stay your " +
      'buttons on that page: they change what every run receives or write your global layer.',
    secLocalModels: 'Local models',
    secLocalModelsText:
      'What is on the machine — GPU and memory, runtime version, whether the model server runs ' +
      'and what it has loaded, installed models with their speed benchmark, which CLI is ' +
      'connected — read. Downloading the runtime or a model, importing a model file, starting ' +
      'and stopping the server, the benchmark, deleting, connecting and disconnecting stay your ' +
      'buttons in that section: they download gigabytes, load the GPU or change CLI settings.',
    secContourAgents: 'Contour agents and embeddings',
    secContourAgentsText:
      'Reading an agent session — read. Computing embeddings — change: it spends the contour ' +
      'budget, and the agent gets back only the number of vectors and their size. Asking a ' +
      'published agent and resetting its session — danger. In none of them does the agent see ' +
      'or pass the contour key. All of it goes only through the active contour that has a key; ' +
      'otherwise the agent refuses before the card.',
    secChats: 'Chats',
    secChatsText:
      'Reading a chat (latest messages, the agent’s plan, the agent’s question, a split proposal ' +
      'and the split plan of its tree), searching the messages of all chats, gathering what ' +
      'in the chats waits for you and listing the folders that have chats — read; secrets in ' +
      'texts are masked. Writing a message into a ' +
      'chat and asking its agent to propose a task split — danger: the card shows the chat, the ' +
      'model and effort the turn goes out with, and whether the agent is busy — then the message ' +
      'waits for its turn to end. Splitting by the proposal is yours: the «Split into N chats» ' +
      'button under the agent’s answer. «Work here», the chat’s group and autonomy, stopping the ' +
      'agent in a chat, pausing and resuming a split group or the whole tree, releasing a group ' +
      'and answering a triage question — change. Resuming a group paused while still queued puts it back ' +
      'in the queue rather than starting it. Cancelling the plan, removing a group, cleaning up copies, ' +
      'permission and branch-gate decisions, auto-approve and starting past the parallel-group ' +
      'limit stay yours. ' +
      'Chat modes (stage auto-continue, the session chain, the permission mode and file ' +
      'edits), the chat’s model picking, chat spend this session, lowered runs and branch ' +
      'overlaps of split groups are reads; overlaps are recomputed as when the hub opens the ' +
      'check: the result is saved and a new overlap is named once in the parent chat. “Close stage” is ' +
      'dangerous: the request goes to the chat’s agent in the same session. Turning on picking ' +
      'the model per task, accepting a delivered group and “Resume” of interrupted groups are ' +
      'changes; “Start now” and relaunching groups stay with you.',
    secAnalyticsPortability: 'Analytics and transfer',
    secAnalyticsPortabilityText:
      'Running Claude processes and where a session runs (a panel chat, a CLI in a terminal or ' +
      'editor, finished) — read. Stopping a CLI session outside the panel — danger: the card ' +
      'names the process; a panel chat, an unidentified process and the process the panel ' +
      'itself runs inside are never stopped by the agent. The plan of carrying the Claude Code ' +
      'environment into another CLI, the trace of the last carry, subscriptions and the ' +
      'content of an environment archive — read. Carrying the environment and undoing the ' +
      'carry — danger: the card shows the diff of every target file, backups are made before ' +
      'writing, and a file you edited after the carry is left as it is by the undo. Building ' +
      'an environment archive into an existing folder — change: secret values in it are ' +
      'replaced with placeholders. ' +
      'Transfer fidelity per entry is a read; hooks and permissions in it are named by event ' +
      'or decision and a short hash, the command is not shown. Transfer subscriptions and carrying single entries ' +
      'into another CLI the agent does not change.',
    cardTitle: 'The confirmation card',
    cardCaption: 'What it shows and why Enter rejects a dangerous action by default',
    cardHeader: 'What',
    cardWhat: 'How it behaves',
    cardChange: 'Change',
    cardChangeText:
      'Heading «The agent asks for confirmation», a human description of the action, its input ' +
      'fields and, when a file is edited, a «What will change» block with the diff. Focus is on ' +
      '«Run». On a line of its own, «Besides the file» names the consequences the diff does not ' +
      'show: a panel mark being removed, an OAuth login being deleted, marks moving on a rename, ' +
      'a group that holds the switch off anyway. The panel writes those lines itself, so they ' +
      'are translated along with the interface instead of staying Russian in an English window. ' +
      'Group and scenario step titles are stored in both languages: in the description, the ' +
      'fields and the diff the card shows them in the window language, and so does the phone.',
    cardDanger: 'Dangerous',
    cardDangerText:
      'Heading «Dangerous action — check carefully». Focus is on «Reject»: Enter pressed out of ' +
      'habit deletes nothing.',
    cardFocus: 'Focus and your typing',
    cardFocusText:
      'While you type in the agent’s input, an arriving card does not take focus — Enter goes ' +
      'into your message, not into a decision. For the first half second after it appears the ' +
      'card’s buttons are dimmed and decide nothing: a click that started before the card showed ' +
      'up is explained by a line on the card instead of vanishing silently.',
    cardDiff: 'A long diff',
    cardDiffText:
      'A diff the panel could not show in full keeps «Run» locked: you cannot confirm what you ' +
      'cannot see. Make an edit that large in the section itself.',
    cardStale: 'The card went stale',
    cardStaleText:
      'If the target changed between showing and clicking — the file was edited in an editor, ' +
      'the contour record or cases changed — the panel writes nothing and says the target ' +
      'changed. The agent re-reads and shows a fresh card.',
    cardTimeout: 'Waits until…',
    cardTimeoutText:
      'The card waits 10 minutes for a click, under Goose 4: Goose waits on an action call for ' +
      'no more than 5 minutes, so the card closes earlier and the «timed out» answer still ' +
      'reaches the model. The end time is written on the card. No decision — the outcome is ' +
      '«timed out», nothing was run. If the CLI itself gives up waiting, the card is withdrawn ' +
      'too, with nothing run: a later decision would land nowhere — the model has already ' +
      'been told it failed.',
    cardOnlyWindow: 'Who decides',
    cardOnlyWindowText:
      'Only a human decides — with a click in the panel window or a button in the phone app ' +
      'paired by token with remote access on. Whoever decides first wins; the other place ' +
      'gets «already decided». A request from the agent bridge is refused even with a token, ' +
      'and the card keeps waiting. Cards of other conversations (another tab, the phone) sit ' +
      'in a separate «Waiting in other conversations» block, labelled and with a jump to that ' +
      'conversation; they never take focus. A foreign card never opens a closed window — only the ' +
      'badge on the «Panel agent» button shows it; only a card of this conversation ' +
      'opens the window by itself.',
    routeTitle: 'Where the conversation goes',
    routeCaption:
      'The agent takes the same route as the panel assistant — one choice in settings for both',
    routeHeader: 'Assistant choice',
    routeWhat: 'What the agent does',
    routeDefault: 'Default provider',
    routeDefaultText:
      'The request goes to the vendor cloud with the active CLI’s own login: ' +
      'Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose or Kimi Code. With the ' +
      '“Claude Code on this model” checkbox on in “Local models”, the agent’s Claude Code answers ' +
      'with the local model, bypassing the cloud.',
    routeContour: 'Contour',
    routeContourText:
      'Claude Code only: with any other CLI a turn through the contour does not start (a ' +
      'refusal naming the CLI). Claude Code is pointed at the panel’s local gateway, which inserts the contour key. The ' +
      'agent process gets a placeholder instead of the key. Gateway down or no key — refusal: ' +
      'no silent fallback to the vendor cloud. The agent’s address carries the Panel assistant ' +
      'section: close that section on the contour and the gateway refuses the agent’s very next ' +
      'request, a conversation already under way included.',
    routeEndpoint: 'Own endpoint',
    routeEndpointText:
      'Refused: the endpoint token would have to be handed to the CLI process. Switch the ' +
      'assistant back to the default provider or to a contour.',

    notTitle: 'What the panel agent is NOT',
    notCaption: 'Neighbours it gets confused with',
    notColumn: 'Not this',
    notMeaningColumn: 'Difference',
    notChat: 'Chat',
    notChatText:
      'Chat works with project code: reads files, runs commands. The panel agent sees no code ' +
      'and never appears in the chat list — it edits the panel’s settings and hands code work, ' +
      'a presentation or a picture to chat: it starts one through a card, then chat takes over.',
    notAssistant: 'Section assistant',
    notAssistantText:
      'The assistant explains and suggests text but runs nothing. The agent runs — through a ' +
      'card.',
    notAutopilot: 'Autopilot',
    notAutopilotText: 'Without your click it changes nothing. Only reads run without a question.',
    notKeys: 'A place for keys',
    notKeysText:
      'A key in a message to the agent never reaches the model — it is masked. Secrets are ' +
      'entered in panel fields the agent opens itself: the contour key in the «Contour» ' +
      'wizard, an MCP secret in the server form, a secret variable’s value in «Environment ' +
      'variables», endpoint and integration tokens in «Settings». The agent reads secrets ' +
      'under the «••••••» mask: an edit that keeps the masks in place keeps the keys from disk, ' +
      'and a value with a secret inside (an address, a header, an MCP variable) is changed by you, not the agent.',
    storageTitle: 'What it writes on disk',
    storageCaption:
      'The panel has no database of its own: only the files below and the files the action ' +
      'itself edits',
    storageJournal: 'Action trail',
    storageJournalValue: '~/.claude/agentdeck/agent-actions.jsonl',
    storageConversations: 'Conversations (History tab)',
    storageConversationsValue: '~/.claude/agentdeck/panel-agent/<id>.json',
    storageBackups: 'Copy before the edit',
    storageBackupsValue: '~/.claude/agentdeck/backups',
    storageTargets: 'Files the action edits',
    storageTargetsValue:
      'CLAUDE.md, skills, settings.json (hooks, permissions, env), .mcp-secrets.env, ' +
      '.claude.json, scripts, plugins, state.json (groups, settings, endpoints, ' +
      'integrations), contours, test cases',
    storageWhen: 'When it reaches Claude',
    storageWhenValue:
      'Rules, skills, permissions and MCP — on the next Claude Code start; a running session ' +
      'picks them up after a restart',
    storageNever: 'Never there',
    storageNeverValue:
      'Keys and secrets in the trail or conversations; a transcript of the turn in ~/.claude/projects',

    limitsTitle: 'Limits and how to undo',
    limitsCaption: 'What works, what does not — and what to do',
    limitsColumn: 'Case',
    limitsMeaningColumn: 'What happens and what to do',
    limitUndo: 'Undo what was done',
    limitUndoText:
      'A file edit can be reverted in «Change history» — the copy before the edit is there — ' +
      'or ask the agent: it can revert a hunk and restore a file from a backup; both are ' +
      'danger actions with a card. Only you restore an encrypted backup: it needs the ' +
      'passphrase. Remove a project in «Projects», a contour draft on its card.',
    limitHooks: 'Settings only you change',
    limitHooksText:
      'The config directory, revealing secrets, backups before writing and their encryption, ' +
      'rule auto-approval, the auto permission mode in every chat, the prompt gate, model prices, the gateway port and remote access are ' +
      'not changed by the agent — it asks you to do it in «Settings». The agent writes hooks, ' +
      'but read the hook command in full on the card: Claude Code will run it.',
    limitStartChat: 'Starting a chat',
    limitStartChatText: 'Claude Code only. For another CLI start the chat in the Chat section.',
    limitPhone: 'Phone',
    limitPhoneText:
      'The «Agent» tab in the app: conversation, waiting cards with a badge on the tab, ' +
      'history and trail — the same agent and the same files as the window. Cards can be ' +
      'decided from the phone too: «Run» and «Reject» work as in the window. Pages and key ' +
      'fields the agent opens open on the computer. Sending the app to the background or ' +
      'losing the connection does not stop the turn: the agent finishes what it started, and ' +
      'the phone, back on screen, re-attaches to the turn and fills in what happened meanwhile. ' +
      'A turn with no phone attached waits ten minutes, then is stopped; what was said stays ' +
      'in history. The window on the computer, after half a minute of silence, re-reads the ' +
      'conversation from the server as before. Card labels follow the app language, as the window follows the panel language.',
    limitMask: 'What is masked in a message',
    limitMaskText:
      'While «Data protection» has no rules, only keys, tokens and a login with password in ' +
      'an address are masked — links, addresses, e-mail and ids reach the agent as is: they ' +
      'are the task data. Own section rules mask more; keys are always masked, even on top of ' +
      'own rules.',
    limitVoice: 'Voice',
    limitVoiceText:
      'A microphone next to the field. Speech is recognised by the browser (Web Speech API — ' +
      'most reliable in Chrome) or by the phone system; the panel gets text only. The text lands ' +
      'in the field and is not sent by itself — you send it, and it then goes through the same ' +
      'data mask as typed text. While dictating, Send is unavailable. If the browser denied the ' +
      'microphone or cannot recognise speech, the reason is written under the field. No ' +
      'microphone, or the browser has not started recording within 15 seconds — the window says ' +
      'so and releases the button and Send, so the text can be typed.',
    limitImages: 'Images',
    limitImagesText:
      'A screenshot or a diagram can go with a question three ways: the image button next to ' +
      'the field, a drag onto the field, and a paste from the clipboard (Ctrl+V). A clipboard ' +
      'shot without a name is called pasted-<date>-<time>.png. Up to eight images per message, ' +
      'up to 20 MB each; PNG, JPEG, GIF, WebP. Anything beyond that is refused right away, at ' +
      'attach time, in words and with the file’s real size. A large shot is scaled down to 1568 ' +
      'pixels on its long side — the model sees no more than that anyway. The image travels ' +
      'into the model’s turn together with the text, and the message keeps its names. The form ' +
      'assistant, the skill or agent structure assistant, a group step’s assistant and the chat ' +
      'with another CLI take images the same way. If the field takes no images right now (it is ' +
      'closed while a reply runs, or a mode without attachments is chosen), an image is ' +
      'attached neither by drop nor by paste: the window says “The image cannot be attached ' +
      'right now…” and names the file, and the browser does not open the dropped file — the ' +
      'typed text stays. The agent on Gemini CLI, Goose or Kimi Code takes no images: a single ' +
      'run of these CLIs has no path for an image to the model, and a turn with one is refused ' +
      'before the start, in words.',
    limitWindow: 'Window',
    limitWindowText:
      'The window sits on the right, 440 pixels wide by default; the page shrinks beside it and ' +
      'stays live — a page the agent opens is visible at once. The strip on the window’s left ' +
      'edge changes the width: drag it with the mouse or focus it and use the left and right ' +
      'arrows (24-pixel steps). The window is never narrower than 360 pixels or wider than 960, ' +
      'and the page always keeps at least 480. The width is remembered in this browser and ' +
      'survives a reload. A page dialog (drafts, suite settings, ' +
      'a server form) opens to the left of the window, not over it: the page behind it is ' +
      'blocked, while the agent window stays readable and you can answer it. Escape in the ' +
      'window closes the window, in the dialog the dialog. On a narrow screen, where the window ' +
      'lies over the page, a dialog still covers everything. The command palette opens the same ' +
      'way, to the left of the window. Close the window while a dialog is open beside it and ' +
      'focus moves into the dialog instead of getting lost.',
    limitCode: 'Project code',
    limitCodeText:
      'The agent does not read project files: it sees only git state and the list of ' +
      'worktrees. Work with code happens in chat.',
    refusalsTitle: 'Refusals and why',
    refusalsCaption:
      'All but the last happen before the start: the window shows «The agent did not answer» ' +
      'with the reason, nothing is written',
    refusalsColumn: 'Refusal',
    refusalsMeaningColumn: 'Reason and what to do',
    refusalProvider: 'CLI without the agent',
    refusalProviderText:
      'The agent works with Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose and Kimi Code; other CLIs ' +
      '(Continue, Cursor, Aider) have no run where the agent holds only the panel actions. The refusal names the CLI — switch the active one in Providers.',
    refusalCli: 'CLI not found',
    refusalCliText:
      'It is not in the PATH of the panel process. Install the CLI and restart the panel; an API ' +
      'key will not help — without the CLI the agent has no actions.',
    refusalEndpoint: 'Own endpoint selected',
    refusalEndpointText:
      'The endpoint key would have to be handed to the agent process. Switch the assistant back ' +
      'to the default provider or to a contour.',
    refusalContour: 'Contour unreachable',
    refusalContourText:
      'The panel gateway is down or the contour key is not saved. Start the gateway or save the ' +
      'key on the contour card. Through a contour the agent goes with Claude Code only: with ' +
      'another active CLI the turn does not start, and the refusal names that CLI.',
    refusalMask: 'Masking rules broken',
    refusalMaskText:
      'The Data protection rules file cannot be read. No message goes out without the mask — fix ' +
      'the rules in that section.',
    refusalBusy: 'The agent is still answering',
    refusalBusyText: 'A turn is running in this conversation. Wait for it or press «Stop».',
    refusalLong: 'A long message on Kimi Code',
    refusalLongText:
      'Kimi Code takes the message only on its command line, and that has a ceiling — 24,000 ' +
      'characters. Longer, and the turn does not start; shorten the message or split it.',
    refusalTimeout: 'Timed out',
    refusalTimeoutText:
      'The card was not decided within 10 minutes — the action did not run. Ask the agent again.',

    compromiseTitle: 'Compromise: «The agent does not approve itself — on the process’s word»',
    compromiseText:
      'A card is decided by a request with the window’s allowed Origin or from a paired phone ' +
      '— a valid token and no Origin, only with remote access on; never with the agent bridge ' +
      'mark. The model does not choose these headers, but a local process of the same user ' +
      'can forge them or read the token file. The panel’s trust boundary is the machine user: ' +
      'such a process edits the same files without the agent.',
    guide: {
      firstTitle: 'Path 1. I want the panel to do this from my words',
      firstCaption:
        'From the button on the page to a completed action, a rejected deletion, the trail, ' +
        'history and a scenario in one card',
      firstLauncher: 'A button on every page',
      firstLauncherText: 'In the side menu, above the sections — «Panel agent».',
      firstEmpty: 'The window next to the page',
      firstEmptyText:
        'The window opens on the right, the page stays visible. Under the tabs — which page the ' +
        'agent considers open.',
      firstChange: 'A change card',
      firstChangeText:
        'The agent asks to add a project. The panel shows what it will write: folder and name, ' +
        'and what happens to the e2e folder: an existing one is synced into cases, otherwise ' +
        'the panel creates e2e/ (hidden through .git/info/exclude in a git project). ' +
        'You are still in the input, so the card did not take focus.',
      firstDone: 'Done — the page with the result',
      firstDoneText:
        'After the click the project is registered, and the panel opened Projects next to the window.',
      firstDiff: 'A file edit: the diff in the card',
      firstDiffText:
        'The rule goes into CLAUDE.md — the card shows the lines to be added and the file.',
      firstSaved: 'The rule in its section',
      firstSavedText: 'After «Run» the rule shows in Rules — just like one added by hand.',
      firstDanger: 'A dangerous action',
      firstDangerText:
        'Deleting the rule: a different heading and the diff of removed lines. You sent the request and left the input — the card put focus on «Reject».',
      firstRejected: 'Enter rejected',
      firstRejectedText:
        'Enter out of habit pressed «Reject» — the file is untouched, the agent asks what to do instead.',
      firstJournal: 'Action trail',
      firstJournalText:
        'Each action as a line: risk class, outcome and who decided — a human, or «no question» ' +
        'for a read.',
      firstHistory: 'Conversation history',
      firstHistoryText:
        'Conversations are kept by the panel, not by Claude Code: open and re-read any of them. ' +
        'While the agent answers, another conversation does not open — wait for the turn to end ' +
        'or stop it. A failed turn is not carried into the next one: the agent will not repeat it on its own. ' +
        'If the turn said or did something before it broke off (an error, «Stop», a panel restart ' +
        'mid-turn), that stays in the conversation as an agent reply marked “The answer was not ' +
        'finished” with the list of executed actions, so the next turn knows what is done. The ' +
        'window writes that mark in the interface language — “The answer was not finished. ' +
        '<reason>” and “Actions performed: …”, a failed action marked “(failed)” — while the ' +
        'conversation file keeps the same tail in English for the model. ' +
        'The reason a turn failed — a stop, an extra tool from the CLI, a refused picture, the CLI exit ' +
        'code — is also written in the interface language in the window and on the phone; the CLI’s own ' +
        'words are shown as they are. ' +
        'The bin next to a row deletes the conversation after a confirmation in the row itself; the ' +
        'action trail stays. The open conversation cannot be deleted while the agent answers. ' +
        'A tab keeps its conversation across F5: the window brings it back on its own. If the reload ' +
        'broke off a turn, the window opens and says so in a red line; the card that was waiting is ' +
        'withdrawn, so ask again. If the connection drops mid-turn (the panel restarted), after half a ' +
        'minute of silence the window stops waiting, reloads the conversation from the server and ' +
        'shows what managed to happen. One conversation in two tabs: the tab that fell behind cannot ' +
        'overwrite the other tab’s turn — it is refused, reloads the conversation and quotes the ' +
        'unsent text so you can send it again. A conversation deleted in another tab is not brought ' +
        'back by a window that still has it open: the message is not sent, the feed is cleared, and ' +
        'the next message starts a new conversation.',
      firstScenario: 'A scenario — in one card',
      firstScenarioText:
        'Describe the steps in words: «Build a scenario “Release”: build, run the checks, describe ' +
        'the changes». The agent does not assemble the group piece by piece; it brings one «Draft ' +
        'a scenario» card: the steps in order on their own line, below them the record that will ' +
        'land in state.json, with «flow»: «scenario» and «isEnabled»: false. A step is its own ' +
        'text (title, prompt, «Done when») or an existing skill; the skill then joins as a member. ' +
        'A taken name or a skill that does not exist is refused before the card.',
      firstScenarioCreated: 'The scenario in «Groups», switched off',
      firstScenarioCreatedText:
        'After «Run» the panel opens «Groups» on the new scenario: the «scenario» and «Disabled» ' +
        'marks, the «When» line and the first steps. The toggle enables it — you, or the agent ' +
        'as a separate action; the steps are edited on the group’s path page.',

      guardsTitle: 'Path 2. The agent refused or «did not do something»',
      guardsCaption:
        'Keys, a stale card, an MCP secret and refusals before the start — all protection, not breakage',
      guardsContour: 'A contour draft without a key',
      guardsContourText:
        'The card says it plainly: you type the key, and enabling is a separate action.',
      guardsKeyField: 'The panel opens the key field',
      guardsKeyFieldText:
        'After saving, the panel opens its own key field. The agent does not see it and only learns ' +
        'whether a key is saved.',
      guardsMasked: 'A key from chat goes out as a label',
      guardsMaskedText:
        'A key pasted into a message is replaced by a label in the conversation — exactly what the model got.',
      guardsStale: 'The card went stale',
      guardsStaleText:
        'The file was edited in an editor while the card waited. «Run» wrote nothing — the panel says why.',
      guardsMcpCard: 'An MCP server with an empty secret',
      guardsMcpCardText:
        'The agent saves the server but leaves the token empty — the panel will not accept a secret from the model.',
      guardsMcpSecret: 'Type the secret in the server form',
      guardsMcpSecretText:
        'After saving, the panel opens the form of that server: the empty secret field is on top with the cursor already in it. ' +
        'The value is written on “Save”; the agent never sees it. The agent window says “The key field is open” ' +
        'only when the field was actually found.',
      guardsOtherCli: 'A CLI without the agent is active',
      guardsOtherCliText:
        'The turn does not start: the agent works with Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose and Kimi Code.',
      guardsDlp: 'Masking rules broken',
      guardsDlpText:
        'Without the mask no message goes to the agent — the window names where to fix it.',
      guardsCli: 'CLI not found',
      guardsCliText:
        'The active provider’s CLI is not on the panel process PATH — the turn does not start. Install it and restart the panel.',
      guardsEndpoint: 'The assistant uses its own endpoint',
      guardsEndpointText:
        'The endpoint key would have to be handed to the agent process, so the turn does not start. Switch the assistant back to the default provider or to a contour.',
      guardsContourDown: 'Contour unreachable',
      guardsContourDownText:
        'The assistant goes through a contour, but the gateway is down or there is no key — the panel never silently falls back to the vendor cloud.',
      guardsBusy: 'The agent is still answering',
      guardsBusyText:
        'A turn is already running in this conversation (for example, from another tab). Wait for it to end and send again.',
    },
  },

  shots: {
    first: {
      '01-launcher': 'The «Panel agent» button in the side menu — on every page',
      '02-empty':
        'The agent window to the right of Overview: tabs «Conversation», «History», «Action trail» and «Page: Overview»',
      '03-change-card':
        'Card «The agent asks for confirmation» for adding a project, class «change»',
      '04-done': 'After «Run»: the project in Projects, the page opened next to the window',
      '05-diff-card': 'A CLAUDE.md edit: the «What will change» block with the rule’s added lines',
      '06-rule-saved': 'The new rule in the Rules section',
      '07-danger-card':
        'Deleting the rule: «Dangerous action — check carefully», class «dangerous»',
      '08-rejected': 'Enter rejected the deletion; the agent asks what to do instead',
      '09-journal':
        'Action trail: outcome and «decided by a human» for changes, «no question» for reads',
      '10-history': 'History: a conversation with its message count, ready to open',
      '11-scenario-card':
        'The card «Create scenario “Release” (switched off)»: three steps in order and a record with flow «scenario»',
      '12-scenario-created':
        'The Groups page: scenario «Release» marked «scenario» and «Disabled», its first three steps',
    },
    guards: {
      '01-contour-card': 'A contour draft card: the key is typed by you after saving',
      '02-key-field': 'The panel opened its own contour key field — the agent does not see it',
      '03-key-masked': 'In the saved conversation a label stands where the key was',
      '04-stale': 'The card went stale: the target changed after it was shown, nothing was written',
      '05-mcp-card': 'MCP server gitlab: in the .claude.json diff GITLAB_TOKEN is empty',
      '06-mcp-secret':
        'Form of the gitlab server: the empty GITLAB_TOKEN secret field on top, cursor in it — the human types the value',
      '07-other-cli':
        'Continue is active: «The panel agent does not work with Continue… The agent works with Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose and Kimi Code»',
      '08-dlp-broken':
        '«The data masking rules are broken: without the mask no message goes to the agent»',
      '09-cli-not-found':
        '«The active provider’s CLI is not in PATH: the agent has nothing to run with»',
      '10-endpoint-unsupported':
        '«The assistant uses its own endpoint: its key would have to be handed to the agent process»',
      '11-contour-unreachable':
        '«The assistant goes through a contour, but the gateway is down or there is no key»',
      '12-busy': '«The agent is still answering in this conversation — wait for the turn to end»',
    },
  },

  diagrams: {
    'action-path':
      'The path of one action: mask, the active CLI without its own tools, the action registry, the card, execution and the trail',
    'keys-and-files':
      'What the agent never receives (contour key, MCP secrets, a key from chat) and which files the panel writes',
  },
};
