import type { chatRu } from '../../ru/topics/chat';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const chatEn: typeof chatRu = {
  topic: {
    title: 'Chat',
    summary: 'The same claude CLI, plus several agents, projects and one shared history',
    lead:
      'Chat in the panel is not a separate bot and not a wrapper around the API. ' +
      'The panel runs the very same claude you use in the terminal and shows its ' +
      'output as it arrives. Everything else follows from that: conversations ' +
      'live in ordinary Claude Code transcripts, conversations started in the ' +
      'terminal show up here, and you pay through your own subscription rather ' +
      'than separately for the panel.',

    whyParallel: 'Several agents at once',
    whyParallelText:
      'Each project runs its own process. Switching tabs does not stop a run: ' +
      'start an agent in one project, move to another, and come back to a ' +
      'finished answer.',
    whyHistory: 'One place for the whole history',
    whyHistoryText:
      'The panel reads the same transcripts Claude Code writes. A conversation ' +
      'started in the terminal, in an editor or on the phone shows up here by ' +
      'itself, and its answer keeps growing before your eyes — no page reload ' +
      'needed.',
    whyVisible: 'You can see what is going on',
    whyVisibleText:
      'Coloured dots on tabs, the agents panel, the cost of a run, attachments ' +
      'and voice input — none of which the terminal has.',

    canParallel: 'Hold several conversations at once, across different projects',
    canQueue:
      'Add messages while the agent is busy: the send button no longer locks, the ' +
      'addition shows both as a strip above the input and in the feed itself — a ' +
      'faint bubble marked “goes out next” — survives a page reload, and goes into ' +
      'the same conversation as soon as the current turn ends',
    canProgress:
      "Watch the agent's plan: the strip above the input shows its own checkpoints " +
      '(done, in progress) and the tree of subagents it handed work to, together ' +
      'with what each one returned',
    canChatDots:
      'Tell conversations apart by the dots in the chat list: a project can hold ' +
      'several agents, and it is visible which one is waiting for an answer',
    canVolume:
      'Hear the agent louder: the agents panel has a notification volume (200% by ' +
      'default), and the browser tab is marked with a dot while an agent waits',
    canOpenFolder: 'Open any folder as a project, even one Claude has never worked in',
    canAttach: 'Attach files by dragging them in or with the paperclip',
    canVoice: 'Dictate a request by voice',
    canStop: 'Stop one agent or all of them at once',
    canEditor: 'Open the project in your code editor with one button',
    canCode: 'View and edit project code inside the panel, with a diff of the agent’s edits',
    canTests: 'See the project’s test cases, edit them and have the agent run them',
    canContinue: 'Continue any past conversation, including ones started in the terminal',
    canFork:
      'Branch the conversation: editing your own message goes off as a new branch ' +
      'instead of appending to the same one',
    canRetry: 'Repeat a failed request with one button, without retyping it',
    canSpend: 'See what a run cost — in tokens or in money, your choice',
    canAnswerButtons: 'Answer an agent question by clicking an option',
    canModel: 'Pick a model and thinking depth — for the whole panel or for one chat',
    canApprove: 'Allow or deny a specific action right in the conversation',
    canSearchMessages:
      'Search the body of a conversation, not just its title and preview: the ' +
      '“By messages” switch in the chat list, with matches highlighted',
    canLoadMore:
      'Load earlier messages with the “Load more” button — a long conversation is ' +
      'not cut off at the last window',
    canExport: 'Export a conversation to a file — Markdown or JSON',
    canRun:
      'Start the project’s dev server right from its chat tab and jump to the address the ' +
      'server printed itself; in a monorepo — one target per package, several at once',
    canFreePort:
      'See who is holding the port you need (process name and PID) and free it with one ' +
      'button, together with a retry',
    canAutostart:
      'Tick the “Autostart” toggle on a target — its dev server comes up by itself on the ' +
      'panel’s next start, without opening a browser window',
    canGit:
      'See the current branch and the list of changed files, switch branches, create a ' +
      'new one, commit and pull — right from the tab, whenever the project has a .git',
    canWorktrees:
      'Create a parallel working copy of the project on its own branch and run a ' +
      'separate agent there — several agents in one repository, out of each other’s way',
    canImage:
      'Ask for an image from a description or a presentation on a topic: a contour, your ' +
      'endpoint or the conversation agent itself does it — the file lands in the data folder ' +
      'and opens as a card',

    cantApprove:
      'Grant permissions in advance: the panel asks at the moment of the action, and ' +
      'the standing list of what is allowed lives in the Permissions section',
    cantDelete: 'Delete or rename conversations — transcripts are only ever read',
    cantEditPlan:
      "Edit the agent's plan from the panel: it keeps the checkpoints itself and " +
      'the panel shows their trace from the transcript — a tick here would drift ' +
      'from its own state',
    cantInterrupt:
      'Interrupt the current turn with an added message: the CLI runs the turn to ' +
      'the end, so the addition goes out at the turn boundary — wait, or press Stop',
    cantGallery:
      'Keep a gallery of images and presentations: the panel holds the last hundred of each on ' +
      'disk and shows no history of them — save what you need with «Download» right away',

    storageTranscripts: 'Transcripts',
    storageTranscriptsValue: '~/.claude/projects/<project-path>/<sessionId>.jsonl',
    storageWhatRuns: 'What is launched',
    storageWhatRunsValue: 'claude -p --output-format stream-json',
    storageSandbox: 'Chats outside a project',
    storageSandboxValue: '~/.agentdeck/chats/<chat id>/',
    storageImages: 'Drawn images',
    storageImagesValue: '~/.agentdeck/media/<id>.png (or .svg) with <id>.json beside it',
    storageDecks: 'Assembled presentations',
    storageDecksValue: '~/.agentdeck/media/decks/<id>.{json,html,pptx,pdf}',
    storageStream: 'How the answer arrives',
    storageStreamValue: 'as an SSE stream — text appears as it is generated',

    imageTitle: 'Images and presentations: the panel assembles the file',
    imageCaption:
      'The «Mode» button left of the input switches what sending does: a message goes to ' +
      'the agent, the panel draws an image from your description, or it assembles a ' +
      'presentation on your topic. Both modes work at any CLI and with no contour at all — ' +
      'only WHO draws changes, and that is said in the caption under the item.',
    imageWho: 'Raster is the panel asking, and the conversation holds nothing of it',
    imageWhoText:
      'When a contour model or your endpoint draws, sending starts no agent: the panel goes to ' +
      'the model itself and shows the result. The conversation is a Claude Code file, and the ' +
      'panel writes not one line into it — so such an image is neither in the thread nor in ' +
      'anything the agent sees. You cannot ask it about the picture: it does not know there is one.',
    imageAgent: 'With no contour the agent itself draws — in a block in its answer',
    imageAgentText:
      'There may be no contour and no key at all: then the mode sends the conversation agent a ' +
      'request to answer with a single block — a drawing in code (SVG) or the structure of a ' +
      'presentation. That is an ordinary turn of the conversation, paid for by the same ' +
      'subscription, and it works at any CLI. The block itself is not shown in the feed: a card ' +
      'stands in its place, and the panel assembles the file on your button. There is no raster ' +
      'on this road — code draws vectors. A block the panel did NOT accept stays in the text as it ' +
      'came, and the panel says so in a line: an example quoted inside another block is never ' +
      'executed — it is a quotation, not a request.',
    deckWho: 'A presentation: the model dictates, the panel makes the files',
    deckWhoText:
      'Only the structure travels upward — the title, the slides, the bullets and the speaker ' +
      'notes; the files themselves are assembled on your machine: HTML to show, PPTX for ' +
      'PowerPoint and PDF. The shown page has no network and no outside fonts — the HTML is ' +
      'served forbidding every external resource. The PDF is printed by the system browser, and ' +
      'if there is none it says so: HTML and PPTX do not disappear with it.',
    deckAsk: 'You are asked how extensive it should be first',
    deckAskText:
      'You name the topic — and the agent asks one short question: a full deck (14–18 slides: ' +
      'sections, diagrams, numbers, a comparison, risks, a conclusion), a medium one (8–10) or a ' +
      'short one (5–6, one statement per slide). You may name your own slide count too; the ' +
      'question carries a recommendation for THIS topic. It is asked once and only where there is ' +
      'someone to ask: on routes with no conversation — the contour, your endpoint, the phone — ' +
      'the panel takes the middle option and says so.',
    deckLook: 'A presentation, not a to-do list',
    deckLookText:
      'A slide comes in seven shapes and the model picks one: bullets, a single large statement, ' +
      'two to four numbers with captions, two columns of comparison, a quote, a dark section ' +
      'divider and a full-slide diagram. The deck colour is its choice as well, but out of six ' +
      'moods — the actual colours are the panel’s, so a deck never arrives unreadable. The rules ' +
      'behind all those decisions live in «Промпты», in the «Презентация» text, and you can ' +
      'rewrite them.',
    deckPictures: 'The model draws diagrams, the panel draws photos',
    deckPicturesText:
      'A diagram is drawn by the model as code, straight into the deck: that costs nothing and ' +
      'works with any CLI. A photographic picture is drawn by the PANEL itself through its raster ' +
      'route — the contour or your endpoint — and embedded into the file as bytes, so the shown ' +
      'page makes no network request at all. No more than two of those per deck: each one is a ' +
      'separate request to a model. With no raster route the slides keep their diagrams and text, ' +
      'and the card says what exactly was in the way.',
    deckRevise: 'Rework: the panel remembers, not the agent',
    deckReviseText:
      'The «Переделать» button on a deck card turns the field into a rework: «make the third slide ' +
      'shorter», «add a diagram at the end». The panel keeps the previous deck’s structure on disk ' +
      'and sends it to the model together with your request — so the agent loses nothing even ' +
      'after the conversation is restarted, and pictures already drawn carry over without ' +
      'spending new requests. The previous files stay on disk: a failed rework does not take away ' +
      'what you have already shown.',
    imageRoute: 'What will do it is said before you press',
    imageRouteText:
      'The server picks the route once and names it under the menu item: the conversation agent, ' +
      'the contour as part of an ordinary answer, the contour’s own images endpoint, or your ' +
      'endpoint profile. Both contour roads — part of the answer and its own images endpoint — go ' +
      'through the panel gateway: the request is in the journal, passes data protection, a ' +
      'contour refusal arrives as a readable reason, and it counts toward the key’s spend when the ' +
      'contour sent usage. The gateway never retries a paid image: a temporary contour refusal ' +
      'comes back as a refusal, not as a second charge. The endpoint profile is your own address, ' +
      'not the corporate key, so it goes directly, bypassing the gateway: its requests are in ' +
      'neither the journal nor the key’s spend. The agent road costs no key at all.',
    imageCard: 'The result is a card, and a file',
    imageCardText:
      'An image the panel drew opens in the right column: the description, who drew it, the size ' +
      'and a «Download» button. The column is a single one, so the image replaces the file preview ' +
      'and the cross brings it back. What the agent dictated is shown as a card right in the feed, ' +
      'in the block’s place: a drawing at once, a presentation on the «Assemble» button. The bytes ' +
      'are files in the panel’s data folder — not one byte of them is in the settings.',
    imageLocked: 'Unavailable — with what exactly is in the way',
    imageLockedText:
      'Exactly one thing locks the mode: there is nobody to do it at all — no conversation beside ' +
      'you, no contour, no endpoint profile. Everything else takes away the raster, not the mode: ' +
      'this contour cannot, the key catalog holds no model with generation, the profile has no ' +
      'address, the gateway is off, that API kind has no such endpoint. “The ' +
      'gateway is off” is two different reasons and the caption tells them apart: the gateway ' +
      'switch is off — turn it on from the contour card; the switch is on while no listener is ' +
      'there — the panel raises the gateway itself, once, and the reason appears only if that ' +
      'failed, in the gateway’s own words. Then the item works by the ' +
      'agent road, and the raster’s reason stands beside it — which is what can be fixed.',
    imagePrompt: 'The rules of both modes live in Prompts',
    imagePromptText:
      'Your own texts live in the Prompts section: «Image» is the system message of the drawing ' +
      'model, «Image in code» the drawing rules for the agent, «Presentation» the slide rules for ' +
      'all three roads. The text travels as the system message wherever there is one; on the agent ' +
      'road the same text begins the request into the conversation, and the separate images ' +
      'endpoint has no system message at all — the caption under the item says so outright.',
    imageLimitTitle: 'Bounds: one request at a time, a hundred files on disk',
    imageLimitText:
      'Drawing takes minutes — you can leave the page, but a second request waits for the first. ' +
      'One image is capped at 8 MB, above that the panel refuses it; a presentation holds at most ' +
      'forty slides, and a drawing in code at most half a million characters. The last hundred images ' +
      'and the last hundred presentations stay on disk and the oldest are swept with all their ' +
      'files; there is no gallery and no history here, so download what you need right away.',

    guideTitle: 'What this document holds',
    guideText:
      'First, why chat exists and how it differs from the terminal and from the ' +
      'neighbouring sections. Then two diagrams and the whole path in screenshots: ' +
      'one conversation from an empty window to the end of a run, then a ' +
      'conversation that became several. Right after the shots come the image and presentation ' +
      'modes — the one place in chat where the panel assembles the file itself. Then the tables of fields ' +
      'and states, and at the end the limits and how to undo or remove each thing ' +
      'listed above.',

    diffTitle: 'How chat differs from its neighbours',
    diffCaption:
      'All of them show the same conversations from different sides — confusing ' +
      'them costs most at the moment something appears to be missing.',
    diffTerminal: 'Chat versus the terminal',
    diffTerminalText:
      'It is the same claude process in the same folder, started by the panel. A ' +
      'conversation begun in the terminal shows up here and the other way round. ' +
      'The panel adds several agents at once, permission cards, attachments and a ' +
      'shared spend counter.',
    diffHistory: 'Chat versus the History section',
    diffHistoryText:
      'Here conversations are held, there they are read: History shows finished ' +
      'transcripts across projects with search over messages and starts no agents.',
    diffForeign: 'Chat versus a foreign CLI',
    diffForeignText:
      'This section drives claude only. Codex, Gemini, Qwen and the rest live in ' +
      'Providers: they keep their own list of conversations and have no session at ' +
      'all — which is why a restart there opens a new chat instead of clearing this ' +
      'one.',
    diffSandbox: 'A project versus the sandbox',
    diffSandboxText:
      'A conversation on a project tab runs in its folder and sees git. The home ' +
      'tab is the sandbox: a separate folder, no repository, nothing of yours at ' +
      'risk.',

    undoTitle: 'How to undo and remove',
    undoCaption:
      'Nothing in this section is irreversible except edits to files — those are ' +
      'undone by git, not by the panel.',
    undoStop: 'Stop the run',
    undoStopText:
      'Stop in the composer kills the current run and rejects a pending permission ' +
      'request with it. The conversation stays; the next message continues it.',
    undoDecline: 'Decline the split',
    undoDeclineText:
      '"Do it here one by one" on the card is a full answer: no chats are created, ' +
      'no copies are made, and the agent gets the refusal as an ordinary reply.',
    undoWorktree: 'Remove a copy of the repository',
    undoWorktreeText:
      'Remove sits under the copy card in the git strip. While an agent is running ' +
      'inside the copy the panel refuses — stop its run first.',
    undoHandoff: 'Decline the continuation',
    undoHandoffText:
      '"Stay here" on the stage card. Auto-continue is switched off by the "carry ' +
      'on yourself" toggle in the same place and is remembered.',
    undoCascade: 'Turn off model routing',
    undoCascadeText:
      'The "pick the model for the task" toggle in the conversation menu is a ' +
      'project rule. Off, it restores the old behaviour: every child runs on the ' +
      'model you chose.',
    undoChat: 'Delete a conversation',
    undoChatText:
      'Not from the panel, and deliberately so: the transcript belongs to Claude ' +
      'Code, not to the panel. It can only be deleted where it lives.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams answer what no state of the screen shows: where a message ' +
        'goes, and what happens after Split.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The composer hands the message to the panel server, which starts a CLI ' +
        'process in the project folder; the CLI writes the conversation into its own ' +
        'transcript on disk and returns the answer as frames the panel shows at ' +
        'once. The panel keeps no database of conversations: history is read from ' +
        'the transcript, which is why a terminal conversation shows up here and one ' +
        'started here shows up in the terminal. One exception: a run routed to a ' +
        'contour starts with the panel’s short system prompt INSTEAD of the CLI’s ' +
        '(a switch on the contour itself, the “Contour” section), because the large ' +
        'prompt drowns a mid-range model. The same card also drops our layers: such ' +
        'a run may go without your personal rules, skills and MCP servers. What ' +
        'exactly was dropped, the conversation header says BEFORE you send a ' +
        'message — otherwise an agent working without your rules would look broken. ' +
        'When a run ends in an error, the feed shows the reason the CLI gave in the ' +
        'answer itself (a contour refusal, say), not a service line from its error ' +
        'stream. One more place the feed speaks up: the model name travels on the ' +
        'command line and is therefore checked against the allowed characters (the ' +
        'Windows shell would read a space, `&` or brackets as a command). A name from ' +
        'the contour catalog passes; one that does not never reaches the CLI, and a ' +
        'feed notice says the run went with the model the CLI picked for itself.',

      basicsTitle: 'One conversation from start to finish',
      basicsCaption:
        'Shot on the "Orders panel" project in C:/work/orders-panel: a conversation ' +
        'about exporting orders to CSV.',
      bEmpty: 'Open the project and start a conversation',
      bEmptyText:
        'The project tab, the New chat button. The header carries the model ' +
        'Claude-opus-5 and the effort "High", and under it the git strip: ' +
        '"feature/orders-export, 4 files changed, +128 −31, 2 ahead". The empty ' +
        'screen says straight away that file edits are allowed and offers four ' +
        'ready openings, from "explain the project structure" to "run the tests and ' +
        'show what fails".',
      bComposer: 'Write the task and attach a file',
      bComposerText:
        'The paperclip puts the attachment as a chip above the text — here ' +
        'orders-export.md. Enter sends, Shift+Enter breaks the line; the microphone ' +
        'dictates into the same field.',
      bAnswer: 'Watch the answer as it is generated',
      bAnswerText:
        'A collapsible Thinking block, rows for the Grep and Write calls with spend ' +
        'on the right (45.0k +3.8k for the first), then the text itself. A timer ' +
        'runs under the answer, the header shows the accumulated 111.3k tok, and the ' +
        'send button is replaced by Stop.',
      bPermission: 'Decide about permissions',
      bPermissionText:
        'The "agent asks for permission" card shows the tool and the command itself ' +
        '— here rm -rf dist. Until you press Allow or Deny the agent stands on that ' +
        'call: the card is a fork, not a notification.',
      bQuestion: 'Answer the agent',
      bQuestionText:
        'The heading "your choice is needed" and the counter "question 1 of 3": ' +
        'questions come in turn, the next opens once the previous is answered. ' +
        'Besides the offered options there is always a free-form answer.',
      bBranch: 'Look into git without leaving the conversation',
      bBranchText:
        'The strip above the feed unfolds into a panel: changed files marked M and ' +
        'A, the branch picker, Pull and Push, a new-branch field and a commit ' +
        'message. Below are the parallel copies; a copy with an agent inside is ' +
        'marked as busy.',
      bMenu: 'Set what may happen without asking',
      bMenuText:
        'Chat settings holds the "auto permissions" and "edits allowed" toggles, ' +
        'and below them rules for every project: commits, branches and a plain push ' +
        'are on, while deleting files, rewriting git history and dropping database ' +
        'data are not. A rule that is on removes the permission card; off brings it ' +
        'back.',
      bActions: 'Actions on the conversation are in the same menu',
      bActionsText:
        'Below the rules: restart the session, export, refresh and open this help. ' +
        'Restart is greyed out while a run is going — wiping the context mid-move ' +
        'means losing the move.',
      bAgents: 'Watch every agent at once',
      bAgentsText:
        'The header panel says "3 active agents", each row telling where it works ' +
        'and in what state (waiting for an answer versus working), the project one ' +
        'showing 111.3k tok and claude-opus-5. Stop all kills them in one press.',
      bHandoff: 'Continue a closed stage in a clean session',
      bHandoffText:
        'The "stage closed — continue in a clean session" card with the counter ' +
        '"step 1 of 8" carries the checkpoint — here .agent/PROGRESS.md — and what ' +
        'to do next. Continue opens the next conversation with that checkpoint; ' +
        'Stay here leaves everything as it is.',

      splitTitle: 'When one conversation becomes several',
      splitCaption:
        'The same project, a different entry: the agent offered to split three jobs ' +
        'on the orders page, and from there nothing is decided in a single chat.',
      sProposal: 'Read the offer',
      sProposalText:
        'The card "split the tasks: 3 groups" shows the composition: Orders export ' +
        'on feature/orders-export, List filters on feature/orders-filters, Returns ' +
        'report on feature/returns-report. Every group carries its kind of work, a ' +
        'model and a "below the ceiling" mark. The line at the bottom counts the ' +
        'price: 3 chats, 3 runs now, 2 below the ceiling, up to 11 runs including ' +
        'triage, plans, work and reviews.',
      sTree: 'Agree — and see what happened',
      sTreeText:
        'Split into 3 chats creates the links: the list on the left gains "Orders ' +
        'export · plan", "· work", "· review" and the same for the second group, ' +
        'each on its own branch. The offer card itself notes that 2 of 3 groups ' +
        'have become chats.',
      sHub: 'Follow the groups from the parent',
      sHubText:
        'The hub "2 split groups" with the "triage applied" chip shows, per group, ' +
        'the chain of stages (plan, work, review), the model, the delay before the ' +
        'first edit and the time at work. Until branches are compared it says so.',
      sAsk: 'Answer the children without visiting them',
      sAskText:
        "A child's permission request arrives in the parent conversation signed " +
        'with the group it came from. The decision goes back where it is awaited — ' +
        'there is no need to open the group chat.',
      sOverlap: 'Compare the branches once the work is done',
      sOverlapText:
        'Compare branches counts the overlaps: two here. ' +
        'src/pages/Orders/OrdersPage.tsx is touched by both groups by right, while ' +
        'src/shared/api/client.ts is red — outside what the second group owns. The ' +
        'merge order sits below, and merging stays with you.',
      sPause: 'Pause the whole tree with one button',
      sPauseText:
        'Stop all kills the conversation together with its children: every group ' +
        'gets a "paused" mark and the button turns into Resume all, counting the ' +
        'links that will come back.',
      sWorktrees: 'Look at the copies on disk',
      sWorktreesText:
        'In the git strip, under Parallel branches, sit the main copy and one per ' +
        'group: feature/orders-export has its own folder ' +
        'orders-panel-worktrees/feature-orders-export, a "dependencies installed" ' +
        'mark linking to the install log, "refresh the local layer" and Remove.',

      shotsTitle: 'The screenshots are taken on an invented project',
      shotsText:
        '"Orders panel" and its branches do not exist: the frames were shot on a ' +
        'separate panel with its own settings folder so that no real path, key or ' +
        'name would travel into this help. The screens are real — only the data is ' +
        'substituted.',
    },

    tabsTitle: 'Tabs and projects',
    tabsCaption:
      'The project list does not scan your disk: it is assembled from transcripts ' +
      'already read, by the directory the conversation ran in.',
    tabHome: 'The home “Chats” tab',
    tabHomeText:
      'Conversations without a project. They run in a separate panel folder — ' +
      'Claude Code treats ~/.claude as protected and will not write inside it.',
    tabProject: 'A project tab',
    tabProjectText:
      'The conversation runs right inside the project directory. The list holds ' +
      'its chats and those of nested folders: for Claude Code a project is the ' +
      'directory it was started in, so a conversation begun in a subfolder would ' +
      'otherwise not show in the tab at all. A neighbour whose name starts the same ' +
      'stays its own project. A new chat is pre-filled with “look around and tell ' +
      'me what this project is”.',
    tabAdd: 'Add a folder',
    tabAddText:
      'The button in the project list opens a directory picker across your drives. ' +
      'That is how you start in a folder Claude has never run in.',
    tabOrder: 'Your own tab order',
    tabOrderText:
      'Drag a project tab to the place you want it, or move it a step at a time ' +
      'from the keyboard with Alt+← and Alt+→; Delete closes the focused tab. The ' +
      'home tab takes no part in the reordering and always stays first.',
    tabsNote:
      'Tabs and their order survive a page reload, and closing a tab closes only ' +
      'the tab — neither chats nor files are touched.',

    toolsTitle: 'The project row: dev server and git',
    toolsCaption:
      'All of it lives in the project tab header and works against the real directory ' +
      'on disk — the panel keeps no copy of the state.',
    toolsRun: 'Starting the dev server',
    toolsRunText:
      'The “Start” button runs the command from package.json (dev, otherwise start) or ' +
      'your own — with the package manager the project actually uses: pnpm, yarn or npm. ' +
      'The panel does NOT assign the port: the app comes up on its own, the panel reads ' +
      'the address from its output and opens the browser once the port answers. A ' +
      'monorepo has several targets — the gear next to the button lists the packages, and ' +
      'they can run at the same time.',
    toolsPort: 'Port already taken',
    toolsPortText:
      'When the server refuses to start (“Port 5173 is already in use”), the panel shows ' +
      'who holds the port — process name and PID — and a “Free it and start” button. It ' +
      'kills nothing on its own: a database or a neighbouring project may live there, so ' +
      'the call stays yours. A port can also be pinned in the target’s settings — then the ' +
      'panel passes PORT and waits for exactly that one.',
    toolsAutostart: 'The “Autostart” toggle',
    toolsAutostartText:
      'It is not about now but about the panel’s next start: a ticked target comes up ' +
      'by itself, with no browser window and no navigation. Close the project tab and the ' +
      'toggle clears on all of its targets.',
    toolsGit: 'Branch, files, commit, pull and push',
    toolsGitText:
      'A strip above the message feed carries the current branch — it is there only when ' +
      'the project has a .git. Next to the branch are the numbers: how many files ' +
      'changed, how many lines were added and removed (over tracked files — a brand new ' +
      'file has no previous version), and how far ahead of and behind the remote you ' +
      'are. While the agent works the strip is re-read every few seconds, and the moment ' +
      'a run ends — at once. Clicking it opens everything else — the list of changed files ' +
      '(the letter on the left: A added, M modified, D deleted, R renamed, ? outside git, ' +
      'U conflict), the list of local branches, the pull row, a “new branch” field and a ' +
      'commit message field.',
    toolsBranchMark: 'A branch switch inside the conversation',
    toolsBranchMarkText:
      'When the agent creates a branch or switches to one, a divider appears at that ' +
      'point of the feed: “Switched to branch …”. Everything after it was edited in the ' +
      'other branch. This is not a guess by the panel — Claude Code writes the branch ' +
      'into every transcript line, so the mark survives a page reload and shows up in ' +
      'old conversations too. In the chat list every conversation is labelled with the ' +
      'branch it is on right now: split children carry their own, and you no longer have ' +
      'to open them one by one to find out.',
    toolsPull: 'The Pull button',
    toolsPullText:
      'By default it pulls into the current branch through its upstream — a plain git ' +
      'pull. The select next to it picks another source: a specific remote branch, which ' +
      'runs git pull origin <branch>. The list holds only branches git has already seen ' +
      'on the remote; the panel pulls no arbitrary ref.',
    toolsPush: 'The Push button',
    toolsPushText:
      'It sends the current branch ONLY, and only forward: --force is never passed ' +
      'anywhere, so this button cannot rewrite anyone else’s history. A branch with no ' +
      'upstream goes out with --set-upstream, otherwise the first push of a new branch ' +
      'would need a terminal. Next to the button you see how many commits you are ahead ' +
      'of the remote. It is disabled where a push makes no sense: no remote, no commits ' +
      'at all, HEAD detached from a branch. If git asks for credentials the operation ' +
      'does not hang waiting for input — the panel runs it with GIT_TERMINAL_PROMPT=0, ' +
      'so you get an error instead of an eternal “working”.',
    toolsNote:
      'A commit takes every change (git add -A) and lands on the current branch. Pull is ' +
      'the only operation that may merge: on a conflict the working tree stays in ' +
      'conflict and you sort it out in a terminal. The panel deletes no branches and ' +
      'never rebases.',

    parallelTitle: 'Parallel branches: several agents in one project',
    parallelCaption:
      'The “Parallel branches” block at the bottom of the git popover creates working ' +
      'copies of the repository. A copy is a separate directory next to the project ' +
      'with its own branch and shared history (git worktree), and it opens as an ' +
      'ordinary project tab.',
    parallelWhy: 'What it is for',
    parallelWhyText:
      'Runs are already parallel: an agent in one tab does not block an agent in ' +
      'another. The shared directory is what gets in the way — two agents in one ' +
      'working tree switch branches under each other and mix their edits. A copy ' +
      'removes exactly that: own directory, own branch, shared history.',
    parallelCreate: 'Creating one',
    parallelCreateText:
      'Type a branch name and press “Create a copy”. No such branch — it is created ' +
      'from the current HEAD; a local branch — the copy checks it out; a branch that ' +
      'exists only on the remote — it is created with tracking (that is how you take ' +
      'apart someone else’s merge request). The directory appears next to the ' +
      'project: <project>-worktrees/<branch>. A finished copy opens as a tab at once.',
    parallelWork: 'Working in a copy',
    parallelWorkText:
      'The copy’s tab is an ordinary project tab: its own chat list, its own agent, ' +
      'its own status dot, its own git controls. The branch shown in the list is the ' +
      'one the copy is on RIGHT NOW: inside it the agent is free to switch and create ' +
      'branches, and the panel does not police that. The local layer and the ' +
      'dependencies are already in the copy — see the two cards below.',
    parallelRemove: 'Removing one',
    parallelRemoveText:
      'The “Remove” button deletes the copy through git. While an agent works there ' +
      'the button is disabled and the server refuses too: deleting the directory from ' +
      'under a live process loses its work silently. Uncommitted changes inside are ' +
      'not surrendered by git either — a second button appears, “Remove with its ' +
      'changes”. The main copy is never removed.',
    parallelNote:
      'The panel never merges: bringing a branch back is your step, not its. The agent ' +
      'inside a copy is not barred from plain git — it can pull main into its branch ' +
      'and resolve the conflicts itself if you ask it to.',
    parallelMemory: 'A tab remembers its conversation',
    parallelMemoryText:
      'Every tab remembers which chat is open in it and brings that one back — not a ' +
      'blank sheet. This is what makes working with several agents possible: leave for ' +
      'another tab, come back, and the same conversation is there; and if an agent ' +
      'asked something meanwhile, you hear a sound and get a toast that jumps to it.',
    parallelMirror: 'The local layer moves by itself',
    parallelMirrorText:
      'A checkout gives the copy only what is in git. Everything the project lives on ' +
      'locally the panel carries over next, no questions asked, and it takes it from FOUR ' +
      'places at once: files under skip-worktree or assume-unchanged (the flag is set in ' +
      'the copy too); what git ignores, by the pattern list; what is untracked yet not ' +
      'ignored (.mcp.json without a line in .gitignore is invisible to both lists — ' +
      'without this source the copy stayed without its adapters); and what is tracked but ' +
      'locally modified — the copy’s checkout holds the COMMITTED version, that is, ' +
      'someone else’s. The third and fourth sources take only what the list names, ' +
      'otherwise the mirror would drag all uncommitted work into the copy. Carried by ' +
      'default: .mcp.json, .claude/, CLAUDE.local.md, .agent/ (without tmp, screenshots, ' +
      'archive and PROGRESS), .env and .env.*, *.local, .dev/, plus the project layer of ' +
      'the other CLIs (.codex/, .gemini/, .qwen/ and the rest). What else to carry and ' +
      'what to subtract — “Copy settings” under the list, one pattern per line as in ' +
      '.gitignore; stored per project, and a copy made by task splitting gets the same. ' +
      '“Refresh local layer” repeats the transfer into a live copy: only what is newer in ' +
      'the main copy moves, the copy’s own edits stay.',
    parallelNever: 'The build environment is built, not received',
    parallelNeverText:
      'node_modules, dist, build, coverage, .next, .nuxt, .svelte-kit, .turbo, .cache, ' +
      '.venv, venv, __pycache__, .pytest_cache, .mypy_cache, .ruff_cache, .gradle, .cxx, ' +
      'target, Pods, .terraform are NEVER carried over, and a pattern of your own cannot ' +
      'drag them in: the ban stands before the list. The reason is not size: inside are ' +
      'the original’s absolute paths and binaries for one platform, so such a directory ' +
      'has to be BUILT in the copy (that is what the post-create command does) rather than ' +
      'received ready-made. Also never: *.log, files over 8 MB and links. In the mirror ' +
      'report the build environment stands as its own explanatory line, not among the ' +
      'skipped: in an ordinary project it lands there every time, and a healthy copy must ' +
      'not look broken. “Left behind” then keeps only what you can actually add to the ' +
      'list — top-level git-ignored entries that are not on it.',
    parallelLinks: 'Skills and hooks come as a link, not a copy',
    parallelLinksText:
      'The .claude/skills and .claude/hooks directories reach the copy as a LINK to the ' +
      'original (a junction on Windows, no administrator rights needed): the mirror writes ' +
      'no files there at all. So an edited skill or hook takes effect in EVERY copy at ' +
      'once, including the one an agent is working in right now — and skills drifting ' +
      'between copies is exactly an agent working by yesterday’s rules. The flip side is ' +
      'the same: editing a skill “inside the copy” changes the original, because it is one ' +
      'directory. The list is deliberately short — a copy’s settings.json is never a link, ' +
      'or a permission granted in one copy would silently appear in all of them. The ' +
      'mirror report names the linked directories on their own line; if linking failed ' +
      '(file system, rights) the files travel as a copy and the report says so.',
    parallelAccess: 'Trust and MCP: every copy gets its own entry',
    parallelAccessText:
      'The answers to “do you trust the files in this folder” and “enable the servers from ' +
      '.mcp.json” are kept by Claude Code not in the project but in its own .claude.json, ' +
      'under the working directory key. A fresh copy is a new directory with no entry, so ' +
      'the human is asked again: files cannot cure that in principle. So the panel creates ' +
      'the copy’s entry from the original’s — trust, the enabled and disabled .mcp.json ' +
      'server lists, own MCP servers and allowed tools. Traces of the original’s work ' +
      '(last*, history) are not carried: to the copy they are lies. Whatever was already ' +
      'answered in the copy is not overwritten — your answer is older than ours. The entry ' +
      'is removed together with the copy, so trust in a vanished path never falls to some ' +
      'later branch with the same name. For the OTHER CLIs the panel fabricates no trust ' +
      'record: their formats are not documented here and writing into a foreign config is ' +
      'not its right — the copy does get the project layer (.codex/, .gemini/ and the ' +
      'rest), and a foreign agent in a fresh copy may ask about trust once.',
    parallelReady: 'An incomplete copy is not let into work',
    parallelReadyText:
      'Before EVERY agent start the copy is checked against the original: are .mcp.json, ' +
      '.claude/settings.json and .claude/settings.local.json, CLAUDE.local.md and .env in ' +
      'place, are the shared directories linked, is there an access entry. If something is ' +
      'missing the panel first fills it in ITSELF and only then, if that failed, refuses ' +
      'and names the gaps: an agent in an incomplete copy does not crash, it silently does ' +
      'the work with the wrong environment, which is worse than a refusal. The same state ' +
      'is always visible on the copy’s card — “copy is complete” or “copy is incomplete” ' +
      'with the list of what is missing and the “Fill in” button (a fresh transfer of the ' +
      'local layer plus the access entry). About access the card knows three answers, not ' +
      'two: present, missing, and “not checked” — when the original itself has no entry ' +
      '(no .claude.json at all, the panel is driving another CLI). The third answer is a ' +
      'quiet one: such an entry cannot be invented, and holding runs over it would lock ' +
      'the work up forever.',
    parallelBootstrap: 'Dependencies are installed before the agent starts',
    parallelBootstrapText:
      'Right after the mirror a preparation command runs in the copy — in the ' +
      'background, before any agent starts there. Which one: the “Command after ' +
      'creating a copy” field in “Copy settings”; empty — the panel looks at the root ' +
      'lockfile (pnpm-lock.yaml → pnpm install --frozen-lockfile --prefer-offline, ' +
      'package-lock.json → npm ci, yarn.lock → yarn install --immutable) and does ' +
      'nothing without one. The command runs through the system shell with CI=1, ' +
      '10-minute ceiling. The copy’s card shows “installing” / “dependencies ready” / ' +
      '“install failed”, the log and a “Retry install” button. A failure stops ' +
      'nothing: the copy stays, and on task splitting the agent gets the log tail as ' +
      'the first paragraph of its task and decides itself whether to retry or go ' +
      'without. Copies from a split are prepared in parallel, and the start waits for ' +
      'all of them. After the command the panel checks the lockfiles (package-lock.json, ' +
      'pnpm-lock.yaml, yarn.lock, bun.lock): ones rewritten by the install are reverted to ' +
      'the index version, newly created ones are removed, and the list shows on the card ' +
      'and in the log.',
    parallelPreamble: 'The agent’s first move in a copy is the task',
    parallelPreambleText:
      'The task of every split group running in a copy opens with a panel preamble: what ' +
      'was mirrored, which command installed the dependencies, which lockfiles were ' +
      'reverted, and — if the preparation failed — the tail of its log. It ends with a ' +
      'direct “the environment is ready — do not check or set it up, start with the task”. ' +
      'Before it, an agent in a fresh copy brought up MCP itself, mirrored .claude/, ' +
      'installed dependencies and reverted lockfiles — minutes and context on every child. ' +
      'How much that helped shows in the parent’s group summary: “first edit after 1m 12s” ' +
      '— from the work link’s creation to the agent’s first Edit/Write call. A group working ' +
      'in the shared directory gets no preamble: that environment is yours.',

    splitTitle: 'Splitting tasks across chats: the agent proposes, you decide',
    splitCaption:
      'A sequel to parallel copies: there a copy is made by hand, here the agent ' +
      'proposes one itself. A list of independent tasks in a single message is ' +
      'sorted into groups, and the panel shows that as a card with two answers.',
    splitWhen: 'When the proposal appears',
    splitWhenText:
      'The agent proposes a split on its own once it sees three or more tasks in ' +
      'one message that do not depend on each other. The proposal comes instead of ' +
      'the work: until you press a button nothing is created and nothing is ' +
      'started. A conversation is asked at most once: refuse and it will not ask ' +
      'again, split and there is nothing left to ask. The same edit across ten ' +
      'files stays one task and is no reason to propose anything. You can also ' +
      'ask for it yourself — the “Split tasks across chats” button in the ' +
      'composer, at any point in the conversation: it works after a refusal too.',
    splitCard: 'What the card shows',
    splitCardText:
      'Shared context on top, then the groups: a name, the branch that will be ' +
      'created and a numbered list of that group’s tasks. No raw JSON in the feed — ' +
      'the decision is made from the makeup of the groups. There are two buttons ' +
      'and both are equal: “Split into N chats” and “Do it here, one by one” — the ' +
      'refusal goes to the agent as an ordinary reply and it carries on right here. ' +
      'The agent need not propose a branch name at all: the panel builds one from ' +
      'the group’s name, transliterating a Russian name into latin. If a proposal ' +
      'block could not be read, a line under it says so — “no buttons” is never ' +
      'left unexplained.',
    splitWhat: 'What happens when you agree',
    splitWhatText:
      'Each group gets its own copy of the repository on its own branch (as in ' +
      '“Parallel branches”), its own chat inside it and its own running agent; the ' +
      'task given to it is the shared context plus that group’s tasks. No new tabs ' +
      'appear: the project stays one, and the groups’ chats stand as a tree under ' +
      'the conversation the proposal came from. A branch name already taken gets a ' +
      'suffix rather than a refusal. If the project is not a repository, the chats ' +
      'are created in the same directory, with no copies. One group failing does ' +
      'not cancel the rest: a separate toast says so, and the other chats stay.',
    splitReview: 'Reviewing someone else’s merge requests',
    splitReviewText:
      'Drop MR (or PR) links into the chat and ask for a review — the split creates ' +
      'one group per link, even for a single link. The copy of such a group is put on ' +
      'the MR branch itself: the panel asks GitLab or GitHub for it over the enabled ' +
      'integration instead of trusting the agent’s word. If that fails, the copy is ' +
      'cut from the base branch and the card says so outright: the findings may have ' +
      'been read from the wrong diff. The review runs on the ceiling model, with no ' +
      'plan and no fixes: the agent is told to change nothing and to write nothing ' +
      'into the MR. It returns a list of findings, and the decision is yours — the ' +
      'card shows up both in the parent summary and in the group chat, sharing one ' +
      'state. Four answers: “Fix in the copy” (a separate run works through the ' +
      'list), “Post to the MR” (the panel writes ONE summary comment; without the ' +
      'integration the button is disabled and says why), “Both” and “Do nothing”. A ' +
      'refusal from the forge does not cancel the fixes — the reason stays on the ' +
      'card. No findings at all closes the group by itself, with no card. With ' +
      'several groups, the “same decision for the rest” toggle clears them at once. ' +
      'After the fixes a separate “Commit and push to the MR” button appears — the ' +
      'only write into someone else’s branch, and only on your click. The panel never ' +
      'merges or closes an MR: merging stays with you.',
    splitTree: 'Where the new chats are',
    splitTreeText:
      'In the list on the left, in the same tab: the chat the proposal came from, ' +
      'and under it, indented and joined by a line, the ones it spawned. The parent ' +
      'is clickable as usual, a child opens on a click and works inside its own ' +
      'copy — the directory comes from the conversation itself, not from the tab. ' +
      'The branch is not broken by the “Today” and “Earlier” headings: children ' +
      'stay with their parent wherever its date puts it. If the parent is not in ' +
      'the list at all (a search matched only a child), the row stays an ordinary ' +
      'one — nothing is hidden.',
    splitParent: 'Every child’s question and permission, answered in the parent',
    splitParentText:
      'A split spreads the work across several agents, but you are still one ' +
      'person. So a question asked by a child chat also shows up in the parent, ' +
      'labelled with who is asking. The answer goes INTO THAT CHAT as the next ' +
      'message: if the child is busy it queues up and arrives when its turn ends; ' +
      'if it is idle it goes out at once, continuing the same session in the same ' +
      'copy of the repository. The parent conversation spends nothing — no turn, no ' +
      'reply — and walking six chats for one and the same choice is not needed. ' +
      'The label survives the answer: the card says which conversation it went to, ' +
      'so after answering six in a row you can see whom you answered. ' +
      'A child’s permission request arrives the same way — Allow/Deny right here, ' +
      'labelled with who is asking. It matters more than a question: on a question ' +
      'the agent keeps working, on a permission it STOPS, and without a shared hub ' +
      'you learn about the halt only by opening its tab. Auto-approval is inherited ' +
      'from the parent, so only dangerous calls and whatever your rules mark as ' +
      '“ask” reach you.',
    splitDone: 'The same proposal is not split twice',
    splitDoneText:
      'Once the group chats exist, the buttons in the card give way to an “Already ' +
      'split: N of N groups became chats” line. The proposal stays the last message ' +
      'in the feed indefinitely, and without this check a second press would create ' +
      'the same copies again — under a suffixed branch name. The panel sees it is ' +
      'done from the conversation’s children: their branches are matched against the ' +
      'branches of the groups.',
    splitButton: 'Create the chats only',
    splitButtonText:
      'A toggle in the card. On, the copies, branches and chats appear but no agent ' +
      'starts: each group’s task lands in the composer of its own chat, where you ' +
      'can read it through and edit it before sending. This is also the rescue when ' +
      'four agents starting at once is not what you wanted.',
    splitOff: 'How to turn the proposals off',
    splitOffText:
      'Settings → “Offer to split tasks across chats”. Off, the agent no longer ' +
      'proposes a split on its own, but the composer button works as before: the ' +
      'setting takes away the initiative, not the ability.',
    splitNote:
      'No subagents appear here: every group is an ordinary chat you talk in ' +
      'yourself, only inside its own copy of the repository. The panel will not ' +
      'bring the branches back together — that is your step, as with copies made ' +
      'by hand.',

    cascadeTitle: 'Model routing: what each chat of a split runs on',
    cascadeCaption:
      'The split decides how many chats there will be. Routing decides what each ' +
      'of them works with: a rename across ten files and an architecture change do ' +
      'not cost the same, yet one rate window pays for both.',
    cascadeWhat: 'Who picks what',
    cascadeWhatText:
      'The agent names the KIND of work in a group — and nothing else. The model ' +
      'for that kind comes from a table in the panel’s code: one table for every ' +
      'run, visible and editable in a single line. Asking the model which model ' +
      'should run it was dropped on purpose — “something weaker will do” is a ' +
      'judgement about itself, not about the task.',
    cascadeCeiling: 'The ceiling is your own choice in the chat header',
    cascadeCeilingText:
      'Nothing new to configure: the ceiling is the model and depth already set in ' +
      'the conversation header (or, if that says “from settings”, the settings ' +
      'value). Nothing rises above it, and the agent knows that: it may ask for a ' +
      'stronger model for a group, but only within the ceiling, and it can never ' +
      'ask for a weaker one for itself.',
    cascadeKinds: 'Kinds of work and what each one gets',
    cascadeKindsText:
      'Mechanical work (the same edit across many files, formatting, moves), ' +
      'implementation (a clear change with ready acceptance criteria) and tests ' +
      'against a written spec run below the ceiling. Investigation (cause unknown), ' +
      'design (architecture, contracts, migrations, security) and review of ' +
      'someone else’s work always stay at the ceiling: the price of a mistake there ' +
      'is not visible right away. A large group does not count as mechanical — the ' +
      'panel raises its rank itself, by task count and task length, without asking ' +
      'the agent.',
    cascadeReview: 'Going lower is paid for by a review: work → review → fixes',
    cascadeReviewText:
      'A group sent below the ceiling gets two obligations added to its task: ' +
      'before saying “done”, run the project’s checks and match the result against ' +
      'the task point by point — and stop if the task turns out to be harder than ' +
      'its kind, instead of muddling through. Then the pipeline starts: as soon as ' +
      'the work ends successfully, the panel opens a REVIEW at the ceiling — same ' +
      'copy, same branch — told to read the diff against the task, list the ' +
      'findings and change nothing. Findings exist → a third link, FIXES by that ' +
      'list, back on the work model; no findings → the chain is closed. In the ' +
      'chat list the links are labelled “review” and “fixes”, each with its own ' +
      'model, and the review feed carries a card with what was found. No new ' +
      'parallel agents appear: the links run one after another, and the split card ' +
      'states before the button how many runs that is at worst. Work that ran at ' +
      'the ceiling itself gets no review — there is nothing to strengthen it with.',
    cascadeLevels: 'Levels: one triage for the whole split and a plan per group',
    cascadeLevelsText:
      'With model selection on, the groups do not start at once. First a TRIAGE ' +
      'runs at the ceiling in the project root — one for the whole split, read-only: ' +
      'who owns which files, where the groups overlap and who gets the contested ' +
      'ones, who must wait for whom, and what to ask you before a group starts. ' +
      'On its verdict the panel creates the copies: groups with no waits right ' +
      'away, waiting ones once their predecessor’s chain ends (the copy then ' +
      'branches from ITS branch, not the main one), held ones after your answer ' +
      'right in the summary under the parent. A waiting group is told in its task ' +
      'who worked before it, on which branch and which files are already touched — ' +
      'from the branch comparison; the comparison did not make it in time — the ' +
      'files are simply not named, and the launch is not held up. Every group opens ' +
      'with a PLAN at ' +
      'the ceiling: a short look at its own task in its own copy, no edits; the ' +
      'plan goes into the work task and the work follows it step by step. No ' +
      'triage or a broken one — the groups start as proposed; no plan — the work ' +
      'goes without it, and that chat’s feed says so in one line: a level never ' +
      'blocks the work. A triage cut short by a panel restart is its own case: no ' +
      'verdict will come from it any more, so the groups stand on the question ' +
      '“start as proposed?” and never start by themselves, and the summary chip ' +
      'says exactly that — the triage was cut short by a restart and the groups are ' +
      'waiting for your answer. That question and the notice in the parent feed are ' +
      'written by the panel itself, not by the agent, so both are shown in the ' +
      'interface language; a question the agent asked stays as it asked it. ' +
      'A task lost in the triage is returned home, a circular ' +
      'wait is cut, and the summary labels that “repaired by the panel”. In the ' +
      'chat list the links are labelled “triage” and “plan”; “Only create the ' +
      'chats” gets no levels.',
    cascadeHub: 'Where to see which stage a group is on',
    cascadeHubText:
      'In the conversation you split the tasks from. Under the agent’s answer sits ' +
      'a summary of the groups: one row per group with its branch, the path it has ' +
      'walked (“work › review › fixes”) and the model of the current stage; a ' +
      'running stage carries a pulsing dot, a click opens its chat. The chat list ' +
      'shows CONVERSATIONS, and the pipeline adds up to three per group — nine rows ' +
      'do not tell you the state of three groups. The agents panel (the “Agents” ' +
      'button in the header) now also says what each running run is being driven ' +
      'by. A group waiting for its predecessor carries a “Release” button in its ' +
      'row: the predecessor’s chain may never end — the run was stopped, the chat ' +
      'deleted, the panel restarted — and then the wait is lifted by hand. The ' +
      'panel hides nothing when it happens: the copy is still branched off the ' +
      'predecessor’s branch, and the task says outright that this work is ' +
      'unfinished. If the group is no longer waiting, the panel answers that there ' +
      'is nothing to release and starts nothing.',
    cascadeOverlap: 'Branch overlap after the work',
    cascadeOverlapText:
      'Triage splits the groups by ownership IN ADVANCE — and gets it wrong in ' +
      'advance too: an agent edits a neighbouring file because otherwise nothing ' +
      'builds. Finding that out at merge time is expensive, so the panel compares ' +
      'the branches itself as soon as any group chain ends, and on the “Check ' +
      'branches” button in the summary. One row is one file touched by more than ' +
      'one group: the path on the left, the groups on the right. Red means the file ' +
      'is OUTSIDE the group declared ownership — a boundary triage had agreed ' +
      'otherwise. Two rightful owners of one file are not painted red: you will ' +
      'still have to merge them, but nothing was violated. The merge order from the ' +
      'triage waits is shown next to it. The same count goes into the task as well: ' +
      'a group branched from its predecessor’s branch receives the list of files ' +
      'that predecessor touched — up to twenty names, the rest as a number. ' +
      'A new overlap is announced once: a ' +
      'recount after every chain does not repeat what was already said. A branch ' +
      'that could not be read is named separately — “no overlap” in place of ' +
      'something unread would be a lie. Before the first check the section says so.',
    cascadePause: 'Stop the whole tree at once',
    cascadePauseText:
      'The same summary carries a “Stop all (N)” button. It stops every running run of ' +
      'the tree — the children, their review and fix stages, clean-session continuations ' +
      '— and remembers how to restart each one. While the tree is paused the panel starts ' +
      'nothing in it on its own: continuations, stages and new children are queued. ' +
      '“Resume all (N)” restarts the stopped runs in their own sessions (the agent keeps ' +
      'its context and is only told it was interrupted and the last tool may not have run) ' +
      'and releases the queue in order. Pressed on a child it stops the same whole tree: ' +
      'stages are started from the top, so everything has to stand still. Paused chats ' +
      'carry a “paused” chip in the summary and in the list. Anything you type into a ' +
      'paused chat yourself is sent as usual — the pause mutes only the panel’s auto-starts. ' +
      'The pause survives a panel restart.',
    cascadeManual: 'Changing a group’s model',
    cascadeManualText:
      'Each group on the split card carries two dropdowns — model and depth. Your ' +
      'choice beats the routing and works in both directions, haiku included, which ' +
      'the panel never assigns on its own: you have seen that group’s tasks. The ' +
      'ceiling still holds for you too. Next to them is the summary line: how many ' +
      'chats will be created, how many runs start right now and how many there ' +
      'will be in total with reviews and fixes — the price before the button.',
    cascadeLimits: 'What the panel will never assign',
    cascadeLimitsText:
      'Depth max — to nobody, under any ceiling: that level is for your own ' +
      'decision, not for a fan of automatically created chats. And no outdated ' +
      'model: only levels can be assigned (haiku, sonnet, opus, fable), and the ' +
      'panel itself expands a level into a concrete name — the newest of that ' +
      'family in the model catalog. This used to be left to the CLI, but there ' +
      '“sonnet”, for one, means not “the current Sonnet” but “the recommended one”, ' +
      'so lowering the rank quietly took a group to the previous generation. A ' +
      'concrete name from the agent’s answer is not accepted at all — otherwise the ' +
      'first model to “remember” last year’s version would take a whole group there.',
    cascadeForeign: 'Other CLIs: codex and gemini only, and downward only',
    cascadeForeignText:
      'When the active provider is not Claude, the conversation has no ceiling at ' +
      'all: the panel knows neither the model configured in that CLI nor what your ' +
      'plan allows. So it only LOWERS, and only where passing a model is ' +
      'documented: Codex gets `-m` plus a reasoning level, Gemini gets `-m` (it has ' +
      'no depth analogue). Mechanical work runs on the lower model of the line, ' +
      'plain implementation and tests on the higher one; for architecture, ' +
      'investigation and review the panel passes nothing, so they run on whatever ' +
      'you configured. The other CLIs have no model routing on purpose: for Qwen ' +
      '“newest in the family” may mean a different tier, for OpenCode choosing a ' +
      'tier would choose a vendor for you, Kimi’s `-m` takes a name from your own ' +
      'model table, and Aider, Goose and Continue are shells over any model at all. ' +
      'The chosen model is shown in the conversation header and applies to every ' +
      'message in it, not just the first. The levels — one triage for the whole ' +
      'split and a plan per group — run here as well: for a foreign CLI the ' +
      'ceiling means a run WITHOUT the chosen tier, that is, the model it would ' +
      'have used without the panel. Triage reads the repository at its root and ' +
      'edits nothing, the plan runs in the group’s own worktree, and the work ' +
      'starts after it on the chosen tier carrying the plan in full. No level ' +
      'blocks: if the block is missing or the run failed, the group goes as ' +
      'before and a line in its feed says what did not come through. ' +
      'The work → review → fixes pipeline runs ' +
      'here too, but the reviewer is the CLI itself: the panel starts the check ' +
      'WITHOUT the chosen tier, that is, on the model the work would have run on ' +
      'without the panel at all. The links show up in the provider’s conversation ' +
      'list as “‹group› · ревью” and “‹group› · правки”, and the parent’s feed ' +
      'carries the same group summary as Claude’s: branch, stages passed in order ' +
      'and whether a run is going. The panel keeps links for other CLIs too — ' +
      'under a key prefixed with the provider (`codex:…`), so a foreign ' +
      'conversation’s address never collides with a Claude session. A group row ' +
      'opens its conversation right here: a foreign chat has no worktree tabs. The same ' +
      'summary compares the groups’ branches (“Сверить ветки”): the count is the same as ' +
      'Claude’s and runs by itself when a group’s chain ends — red marks only a file ' +
      'outside the declared ownership, and a new overlap is stated as a line in the ' +
      'parent’s own feed. The whole ' +
      'tree is stopped and resumed from there too (“Остановить всё” / “Продолжить всё”): ' +
      'the pause lives on the server and mutes auto-starts, so a stage created while it ' +
      'holds waits in the queue. One difference is stated on the button itself: a foreign ' +
      'CLI has no session, so continuing means asking the same thing again rather than ' +
      'returning to the same place. Clean-session continuation follows from that: ' +
      'with a foreign CLI the panel reads “restart the session” in the tail of an ' +
      'answer just as it reads the block, and opens a NEW conversation in the same ' +
      'directory — with the checkpoint file and the original task of the whole run. ' +
      'The limits are Claude’s: eight continuations in a row, a stop when the ' +
      'checkpoint file has not changed, no continuation after a failed run; the ' +
      'notice in the feed names both the step number and the reason for a refusal. ' +
      'The “Перезапустить” button in the header does the same on your word: a fresh ' +
      'checkpoint starts the continuation at once, a stale one asks the agent to write ' +
      'it and the panel carries the end of that turn through to the continuation.',
    cascadeOff: 'How to turn it off',
    cascadeOffText:
      'Chat menu (the “···” button in the header) → “Match the model to the task”. ' +
      'The setting is remembered per PROJECT, not per conversation, and it is on by ' +
      'default. Turn it off and every child of a split runs on the model you chose, ' +
      'with no kinds and no additions to the task: exactly how the panel worked ' +
      'before routing existed.',
    cascadeNote:
      'The panel has to recognise the ceiling, or there is no routing at all: an ' +
      'unfamiliar vendor or model name and everything runs at the ceiling, as ' +
      'before. The same holds for a ceiling weaker than opus: there is nothing to ' +
      'save there, and the risk remains.',

    handoffTitle: 'Continuing in a clean session: the stage closes, the context stays behind',
    handoffCaption:
      'A conversation gets more expensive with every turn: the whole context ' +
      'window goes to the model on each request, so after a task is done you ' +
      'keep paying for a conversation nobody needs any more. In the CLI itself ' +
      'that is cured by /clear, but neither the model nor a hook can call it. ' +
      'The panel owns the process, so a “clean session” here is a new ' +
      'conversation in the same directory that knows exactly what the ' +
      'checkpoint file says.',
    handoffWhen: 'When the offer appears',
    handoffWhenText:
      'The agent offers the move on its own once a stage is closed: the task is ' +
      'done and verified, a sizeable part of a big job is done, or the context ' +
      'window got heavy — and only after it has tidied its working files. The ' +
      'offer may come in words too: “restart the session”, “/clear”, “continue ' +
      'from .agent/PROGRESS.md” at the end of an answer is read like the block — ' +
      'such a phrase used to be the end of the work until morning. You can ask ' +
      'yourself: the “Close the stage and continue in a clean session” button in ' +
      'the composer asks the agent to prepare the move, and “Restart the session” ' +
      'in the header menu does it at once — a fresh checkpoint: a new conversation ' +
      'is started right there; a stale one: the agent is asked to update it, and ' +
      'the panel takes the end of that turn to a clean session itself. While a ' +
      'run is going the button is dimmed: wiping context mid-turn loses the turn.',
    handoffSize: 'The second reason: the conversation got expensive',
    handoffSizeText:
      'Besides a closed task there is a reason the agent will not see: the size ' +
      'of the window. Context goes to the model in full on every turn, and by ' +
      '200 thousand tokens almost the entire turn is resending the old one. ' +
      'Settings → “Offer to continue once the window reaches”: the panel looks ' +
      'at the run’s last turn and sends a notification with the size; clicking ' +
      'it starts the continuation from .agent/PROGRESS.md. It will not remind ' +
      'you again for the same conversation until the window grows noticeably ' +
      'further, and with auto-continue enabled there it moves on its own — the ' +
      'same safeguards apply.',
    handoffCard: 'What the card shows',
    handoffCardText:
      'What is closed, what was pruned from the working files, the checkpoint ' +
      'file and the full text of the task — exactly what will travel into the ' +
      'new session. There is no raw JSON in the feed: you decide by the ' +
      'content. Two buttons, both legitimate: “Continue in a new chat” and ' +
      '“Stay here” — the refusal goes to the agent as an ordinary message and ' +
      'the conversation carries on.',
    handoffWhat: 'What happens when you agree',
    handoffWhatText:
      'A new conversation starts in the same directory and the same branch: no ' +
      'copy of the repository is made, only the context window changes. Model, ' +
      'thinking effort and permissions are inherited from the closed run, the ' +
      'task from the card goes out as the first message, and the tab moves to ' +
      'the new chat. The old conversation does not go anywhere — it stays in ' +
      'the chat list and can be reopened and reread. The “Only create the chat” ' +
      'toggle puts the task into the composer instead of starting the agent — ' +
      'so you can read it through and edit it.',
    handoffAuto: '“Keep going on your own” and the chain cap',
    handoffAutoText:
      'The toggle on the card is auto-continue FOR THIS conversation, and it is ' +
      'on out of the box: a chain with nobody at the panel is the normal night ' +
      'mode, not an exception. The decision is made by the server, not by the ' +
      'tab: the chain survives a closed browser — the agent works at night, you ' +
      'look in the morning. Every continuation gets the original task of the whole ' +
      'job along with the checkpoint, so the third session in a row still knows ' +
      'the bounds of its group. A conversation continues at most eight times in a ' +
      'row (review and fix stages do not count), and if the checkpoint is word for ' +
      'word the same as at the previous move the panel stops earlier: the agent is ' +
      'going in circles. A move that did not happen is explained by a toast: the ' +
      'run failed, the checkpoint was not updated or did not change, the chain ran ' +
      'out. Turn it off per conversation with the toggle, or everywhere in Settings ' +
      '→ “Continue on its own in every conversation”; one switched off by hand ' +
      'stays off. Neither of them waives the safeguards.',
    handoffTidy: 'Tidying the working files — half the point',
    handoffTidyText:
      'A clean session reads exactly the checkpoint file (.agent/PROGRESS.md by ' +
      'default), so the agent must prune and write first and only then offer ' +
      'the move: closed items out of PROGRESS, finished ones out of TASKS.md — ' +
      'each moved to .agent/ARCHIVE.md as a single line — leaving only what is ' +
      'open, the decisions and the paths into the code. Otherwise the saving ' +
      'turns into a loss: the new agent picks up the wrong thing. The same rule ' +
      'ships as the ready-made “Tidying the agent working files” template in ' +
      'the Skills section — for when you want the agent tidying without any ' +
      'handover at all.',
    handoffOff: 'How to turn the offers off',
    handoffOffText:
      'Settings → “Offer to continue in a clean session”. Off means the agent no ' +
      'longer offers the move by itself, but the composer button still works: ' +
      'the setting takes away the initiative, not the ability. The window-size ' +
      'threshold is turned off separately, by the neighbouring “Never offer”: ' +
      'they are different reasons and must be able to go quiet independently.',
    handoffNote:
      'The panel never wipes context silently, whatever the toggles say: a move ' +
      'is always a NEW conversation, and the old one stays in the list in full. ' +
      'A conversation’s toggle survives a panel restart — together with the count ' +
      'of moves and the checkpoint fingerprint: after a restart the cap of eight ' +
      'and the “the agent is going in circles” stop do not start counting again. ' +
      'A chain nobody came back to for a day is forgotten. The “every ' +
      'conversation” setting is the toggle’s default value, not an order.',

    codeTitle: 'Project code: what the agent changed, and editing on the spot',
    codeCaption:
      'The “Project code” button in the project tab header opens a window: files on ' +
      'the left, one file on the right with syntax highlighting and this ' +
      'conversation’s edits.',
    codeTree: 'Two lists on the left',
    codeTreeText:
      '“Changed” is a flat list of everything in the project that differs from the last ' +
      'commit. On top — the summary: branch, how many files, how many lines. Below, in ' +
      'two groups: “In this conversation” — files the agent touched, with the count of ' +
      'added and removed lines — and “In the working tree” — the rest that git sees ' +
      '(your own edits, earlier conversations, the terminal), with a status letter. That ' +
      'is why the window makes sense in a fresh chat too, where the agent has changed ' +
      'nothing yet; the first file of the list is loaded right away. ' +
      '“All files” is the whole project tree: a changed file is marked there with a ' +
      'green name and line counts, and every folder on the way to it carries a green ' +
      'dot, so the result of a run is visible without expanding everything. The tree ' +
      'is loaded one expanded folder at a time; build directories (node_modules, ' +
      'dist, .git and the like) are not shown at all. The lists and the code scroll ' +
      'on their own — the window itself never moves. The border between the list and ' +
      'the code can be dragged with the mouse or moved with the left/right arrows; ' +
      'the chosen width is remembered ONCE for the panel and applies to every project.',
    codeMemory: 'Tab memory',
    codeMemoryText:
      'The open file, the expanded folders and the display modes are remembered per ' +
      'project tab and restored the next time the window opens. This lives in the ' +
      'panel’s state on disk, not in the browser: clearing the cache or switching ' +
      'browsers does not lose it. Close the project tab and the record is erased — ' +
      'next time the window opens from scratch.',
    codePreview: 'Not only code',
    codePreviewText:
      'Images (png, jpg, gif, webp, avif, bmp, ico) and PDFs open as images and ' +
      'documents rather than a “binary file” notice. SVG and Markdown get two tabs: ' +
      '“Code” — the source with every edit and the diff, “Preview” — what it turns ' +
      'into. A file that has a preview opens on it; the one exception is an unsaved ' +
      'edit — you come back to it in “Code”. The SVG and Markdown preview is built ' +
      'from the TEXT IN THE EDITOR, so an edit is visible before saving. Images and PDFs are ' +
      'fetched from the panel by the browser itself; formats the browser would ' +
      'execute (html and the svg file itself) are never served that way.',
    codeDiff: 'Green and grey',
    codeDiffText:
      'Green marks the lines the agent added — they really are in the file. The grey ' +
      'blocks between lines show what used to be there: that code is gone from the ' +
      'file, cannot be edited and is never saved anywhere. The “Agent edits” toggle ' +
      'turns the highlighting off and leaves a plain editor.',
    codeEdit: 'Editing and saving',
    codeEditText:
      'The file is edited right in the window: syntax highlighting, line numbers, ' +
      'in-file search, undo. The “Save” button or Ctrl+S (⌘S) writes it. The edit goes ' +
      'into the real project file, and the previous version goes into the panel’s ' +
      'backups, where it can be restored from.',
    codeLimitsTitle: 'The diff is derived from the transcript, and that has limits',
    codeLimitsText:
      'The previous text is stored nowhere — the panel rebuilds it by rolling the ' +
      'agent’s edits back over the current file. So: a file the agent overwrote whole ' +
      '(the Write tool) shows up as entirely new — the transcript holds no previous ' +
      'text; an edit whose fragment was later rewritten outside this chat counts as ' +
      'unmatched, and the panel says how many there are. What is not shown is stated ' +
      'as such; the panel will not invent the agent’s work for it.',
    codeSaveTitle: 'Concurrent writes',
    codeSaveText:
      'If the agent changed the file while it was open, saving is refused: the panel ' +
      'checks the write time on disk and will not let you silently overwrite someone ' +
      'else’s work. Reload the file (reopen it in the tree) and reapply your edit.',

    testsTitle: 'Project tests',
    testsCaption:
      'The project test cases do not live in the chat: they have their own section, with a ' +
      'library, plans, a manual runner and a report.',
    testsMovedTitle: 'Everything about tests is in the Tests section',
    testsMovedText:
      'Only one thing about tests is visible from the chat: an agent run is an ordinary ' +
      'conversation with it, and it can be opened as one to see what it did step by step. ' +
      'Everything else — where the cases live, how to keep them, what to run them with and ' +
      'where to look afterwards — is in the help for the Tests section.',

    askTitle: 'Agent question: the “Your choice is needed” card',
    askCaption:
      'When the agent needs a decision it asks a question — sometimes several at ' +
      'once. You can answer right in the chat instead of switching to the terminal.',
    askOrder: 'One question at a time',
    askOrderText:
      'Exactly one question is active — “question 2 of 4” in its header says where ' +
      'you are. The ones not reached yet collapse into an “Answer the previous ' +
      'question” line with no options shown at all, so you cannot pick in something ' +
      'that would not be accepted anyway. The answer to the whole card goes out as ' +
      'ONE message, so answering out of order would drop the remaining questions on ' +
      'the way. A question marked “multiple choices allowed” is closed by the “Next” ' +
      'button, not by the first tick.',
    askOwn: 'Your own answer, when none of the options fit',
    askOwnText:
      'The options are invented by the model, and sometimes the right one is not ' +
      'among them. Below the list there is “Answer in your own words”: type it, ' +
      'press Enter, and it takes the place of a chosen option, marked “your ' +
      'answer”. From there it behaves like any option — visible, editable, and ' +
      'sent in the same single message together with the answers to the other ' +
      'questions. Better than the composer: there the answer loses its link to the ' +
      'question, and the card stays unanswered.',
    askChange: 'A misclick is fixable',
    askChangeText:
      'An answered question collapses into a “what was asked — what was chosen” ' +
      'line with a “Change” button next to it: you can go back and re-answer before ' +
      'sending. A single question with a single choice is sent on the click itself — ' +
      'there is nothing to confirm there.',
    askSent: 'Sent — and it shows',
    askSentText:
      'Once sent, the card dims and says what became of the answer: “the agent is ' +
      'thinking” or “queued — it will be sent when the agent finishes its turn”. The ' +
      'note appears on the click, not on the server reply: the agent answers in tens ' +
      'of seconds, and all that time it must be obvious the click went through. An ' +
      'answered question stays answered: switching tabs and reloading the page do ' +
      'not revive it, and it cannot be answered twice — that would be a second turn.',
    askBusy: 'The agent is busy — you can still answer',
    askBusyText:
      'The question arrives MID-turn: the agent asks it and goes right back to ' +
      'writing code. That is why the options are not dimmed while a run is going — ' +
      'the choice is needed exactly now. An answer to a busy agent queues up above ' +
      'the composer and is sent as soon as the turn ends; the turn is not interrupted.',
    lostTitle: 'The connection to a run can be lost — and you will be told',
    lostText:
      'The event stream lives in the browser while the agent lives on the server, so ' +
      'a sleeping machine or a blinking network breaks the view, not the work. Half ' +
      'a minute of silence and the feed says “connection lost, reconnecting”; the ' +
      'half-written bubble goes dark on purpose — it is cut mid-sentence, while the ' +
      'full answer is being written to the transcript the feed reads from. If the ' +
      'reconnects do not help, instead of silence you get “show from the history” — ' +
      'reread the conversation, where the answer already is.',
    askOldTitle: 'Your answer closes the question — the agent’s next message does not',
    askOldText:
      'Having asked, the agent keeps writing: it does not wait for the answer, and ' +
      'within seconds the card stops being the last message in the feed. The buttons ' +
      'stay anyway — otherwise the form would go dead mid-way, on question two of ' +
      'four. The card closes when YOU have answered: in a question followed by a ' +
      'message of yours the options are plain text rather than buttons — it is done, ' +
      'and a click would send the agent a choice out of nowhere.',

    dotsTitle: 'Coloured dots: what the agent is doing',
    dotsCaption:
      'The dot sits on the project tab and in the project list. For a project with ' +
      'several runs, the most alarming state is shown.',
    dotGreen: 'Green',
    dotGreenText: 'The agent is working. The dot pulses while events keep arriving.',
    dotGrey: 'Grey',
    dotGreyText:
      'The agent is working, but no events have arrived for five minutes — a long ' +
      'command or a test run, say. Not an error: the run goes on and still counts ' +
      'as running; the dot only asks for a glance.',
    dotYellow: 'Yellow',
    dotYellowText:
      'The agent asked a question or wants permission and is waiting. A question ' +
      'shows up even for a conversation the panel did not start: it is read from ' +
      'the transcript, so an agent in a terminal or another window calls too.',
    dotRed: 'Red',
    dotRedText:
      'An error, a rate limit, or the panel lost its connection to the run. Long ' +
      'silence is never painted red: that is the grey dot.',
    dotNone: 'No dot',
    dotNoneText: 'Nothing is running in this project right now.',

    panelTitle: 'The agents panel and parallel launch',
    panelAgents: 'Agents panel',
    panelAgentsText:
      'A button in the chat header with a counter. Inside are all active runs, ' +
      'sorted by how alarming they are: errors first, then those waiting for a ' +
      'reply, then those working. Each row shows the project, status, spending and a ' +
      'stop button. Clicking a row opens that project’s tab and shows the live ' +
      'stream of that agent. At the bottom: the session total across all runs.',
    panelParallel: 'Run in several projects',
    panelParallelText:
      'The button lives in the project list on the home tab, not in the header. One ' +
      'request goes to several projects at once: tick the projects, write the task, ' +
      'and an agent starts in each. The window has its own edit toggle and its own ' +
      'model choice. Handy for sweeps like “check every repository for X”.',
    panelParallelModel: 'The fan-out model is chosen in the window itself',
    panelParallelModelText:
      'Next to the task sits the same model + effort pair as on the split card, with ' +
      'no rung above the model of the conversation itself. It defaults to that pair, ' +
      'and lowering it is a deliberate act: five agents starting at once at the ' +
      'ceiling eat the rate window faster than anything else the panel does, while ' +
      'fan-out work is usually the same and well understood. One rung covers the ' +
      'whole launch — different models per project would give different results for ' +
      'one and the same task. Lowering is paid for with a delivery bar: the task ' +
      'gains the duty to run the project checks, verify the result point by point ' +
      'and stop when the work turns out to be of another class. No review at the ' +
      'ceiling is started here — the stage pipeline only runs for split children, in ' +
      'their own copy of the branch, and promising it to the fan-out would be a lie.',
    panelParallelCost: 'From the third agent the window names the price',
    panelParallelCostText:
      'Pick three projects or more and leave the ceiling in place — a warning appears ' +
      'under the button: this is the most expensive launch the panel makes, and it ' +
      'eats the rate window faster than anything else. The warning forbids nothing; it ' +
      'names the price before the click and disappears the moment the rung goes down. ' +
      'It counts the SELECTED projects, not the available ones: two agents at the ' +
      'ceiling are an ordinary working launch and nothing gets in their way.',
    panelParallelJournal: 'Where you later see how it ended',
    panelParallelJournalText:
      'Lowered runs land in a journal, and the journal in the “Lowered fan-out runs” ' +
      'card on the analytics page: a row per run with its directory, its model and ' +
      'whether the panel saw the checks run. That is the only way to learn whether the ' +
      'delivery bar was met: the panel cannot force an agent, but it can show what the ' +
      'agent started. Details are in the analytics help.',
    panelParallelTree: 'What you launch becomes a tree, not tabs',
    panelParallelTreeText:
      'The launched agents’ conversations hang as branches under the chat they were ' +
      'started from — exactly as with task splitting. No separate project tabs ' +
      'appear: three ticked projects used to mean three tabs, while an agent’s ' +
      'question or permission request lived only in ITS OWN, which from the outside ' +
      'looked like a stalled run. Now everything the agent is stuck on shows up in ' +
      'the parent chat and is decided there. Launching with no conversation selected ' +
      'is the exception: there is nothing to hang them under, so the tabs open as ' +
      'before — otherwise the run would be visible only in the agent panel.',
    panelNote:
      'Projects missing from disk are not listed at all and never reach a parallel ' +
      'launch: there is nowhere to work in a folder that no longer exists. The ' +
      'conversations survive — find them through the chat search.',

    composerTitle: 'What the input field can do',
    composerEnter: 'Enter and Shift+Enter',
    composerEnterText: 'Enter sends the message, Shift+Enter adds a line break.',
    composerVoice: 'Voice input',
    composerVoiceText:
      'The microphone button starts dictation with a sound track. What you dictate ' +
      'is appended to what you already typed rather than replacing it. It works ' +
      'where the browser supports speech recognition — otherwise the button is off.',
    composerFiles: 'Attachments',
    composerFilesText:
      'The paperclip or a drag onto the field. Up to 20 MB per file; images, PDF, ' +
      'markdown, text, tables, code. The file is stored in a panel folder, and ' +
      'Claude gets the path and reads it from disk itself.',
    composerChips: 'Quick action chips',
    composerChipsText:
      'In an empty chat — ready-made openings: in a project that means review, ' +
      'bug hunting, a structure walkthrough, tests. A chip fills the field but does ' +
      'not send: you can add to it first. Next to them sits a separate “Open in ' +
      'editor” chip — not about the conversation, it just opens the project.',
    composerStop: 'Stop',
    composerStopText: 'While an answer is streaming, the send button becomes a stop button.',

    editsTitle: 'Edit mode: what the agent may change',
    editsCaption:
      'The toggle appears only inside a project: outside one, edits are always ' +
      'allowed because there the files are the result of the work. Inside a project ' +
      'edits are allowed by default too, so check where the toggle stands before ' +
      'giving a task in an unfamiliar repository.',
    editsOff: 'Read only',
    editsOffCaption: 'toggle switched off',
    editsMode: 'permission-mode default',
    editsModeCaption: 'reading, search, analysis',
    editsResult: 'Edits do not go through',
    editsResultCaption: 'there is nowhere to confirm them',
    editsOn: 'Edits allowed',
    editsOnCaption: 'the default position',
    editsOnMode: 'permission-mode acceptEdits',
    editsOnModeCaption: 'edits without asking',
    editsOnResult: 'Project files change',
    editsOnResultCaption: 'the agent writes to disk',
    editsResetTitle: 'The toggle remembers where you left it',
    editsResetText:
      'Its position survives tab switches, other chats and page reloads: it used to ' +
      'reset on every refresh, and the agent stalled over nothing. The flip side is ' +
      'that switching it off is a deliberate act — it never returns to read-only on ' +
      'its own. The exception is the parallel launch window: it has its own toggle, ' +
      'and it opens on “edits allowed”, the same as a normal chat.',

    autoApproveTitle: 'Auto-approving permissions',
    autoApproveText:
      'The «Permissions auto» toggle lives in the «Chat settings» menu on the right ' +
      'of the header, and it is ON by default. It takes the routine ' +
      'away: a reversible request is approved by the panel itself, and no ' +
      '«Allow/Deny» card appears. Reading files is always allowed, whatever this ' +
      'toggle says: opening a file, searching the code and listing a directory ' +
      'leave nothing to undo, while a card on every file the agent opened stalled ' +
      'runs more often than everything else combined. For the rest of the tools ' +
      'the border is irreversibility, not «writing»: a ' +
      'commit, a push, a branch, moving a file, restarting a process and an API ' +
      'call go to the agent, because there is something to undo them with. What ' +
      'still asks is what leaves nothing to roll back to: deleting files (rm, ' +
      'Remove-Item), wiping work and history (git reset --hard, clean, restore, ' +
      'force push, deleting a branch), tearing down data (DROP, TRUNCATE, DELETE ' +
      'FROM, rolling migrations back), tearing down containers and infrastructure ' +
      '(docker rm and prune, kubectl delete, helm uninstall, terraform destroy), ' +
      'publishing to someone else’s registry (npm publish), deleting and merging ' +
      'on a repository host, shutting the machine down — and deleting MCP calls. ' +
      'On top of that your own ask and deny rules from settings.json still ask: ' +
      'where you wrote «ask me», the toggle does not decide for you. An unclear ' +
      'case goes to a human too: a command the panel could not parse counts as ' +
      'irreversible. With edits switched off, file edits stay yours even when ' +
      'auto-approval is on. The toggle takes effect immediately, mid-run included, ' +
      'its position is remembered, and split chats inherit it from the parent. ' +
      'The border itself is not carved in stone: permission rules place it, see below.',

    rulesTitle: 'Permission rules: what the panel approves itself',
    rulesText:
      'In the same «Chat settings» menu, below the toggles, sits a list of rules — ' +
      'one per kind of action. A rule that is on the panel approves itself; a rule ' +
      'that is off brings back the «Allow/Deny» card. Out of the box WRITES are ' +
      'allowed (merge request comments and threads, Jira tickets, wiki pages, ' +
      'commits, branches and a plain push), while TEARDOWN asks: deleting files, ' +
      'wiping git history and force-pushing, tearing down database data, ' +
      'containers and infrastructure, publishing packages, deleting and merging in ' +
      'external services, running what was downloaded from the network. The rules ' +
      'are shared: switched on in one project, they hold in every project and on ' +
      'the phone — they live in the panel settings, not in a conversation. What ' +
      'they do not override: your own ask and deny rules from settings.json (they ' +
      'beat any rule you switch on), read-only mode and a question to a human.',

    historyTitle: 'How a conversation continues',
    historyCaption:
      'The chat identifier is the transcript file name. That is what the ' +
      'conversation is resumed by.',
    historyId: 'chat id',
    historyIdCaption: 'also the sessionId',
    historyResume: '--resume <id>',
    historyResumeCaption: 'the CLI brings the past session back',
    historyCwd: 'Working directory',
    historyCwdCaption: 'taken from the transcript itself',
    historyFolderTitle: 'A session is bound to its directory',
    historyFolderText:
      'A conversation can only be continued from the folder it started in: the CLI ' +
      'looks for the session among the sessions of the current directory. That is ' +
      'why a chat folder is never renamed, and if the project directory is gone ' +
      'from disk the panel says plainly that there is nothing to continue.',

    retryTitle: 'When a run fails',
    retryCaption:
      'On an error two buttons appear in the header. Both repeat the last request — ' +
      'there is nothing to retype.',
    retryRepeat: 'Retry',
    retryRepeatText:
      'The same request with the same permissions. Useful when the cause was ' +
      'external: the network dropped, a limit was hit, the process died.',
    retryFull: 'Allow and continue',
    retryFullText:
      'The same request but with full access: the agent does everything without ' +
      'asking. The button for when the run stalled on permissions specifically.',
    retryNoteTitle: 'Full access really does mean full access',
    retryNoteText:
      'In that mode neither the edit toggle nor the rules from the Permissions ' +
      'section apply: the agent does whatever it decides to. Worth pressing when ' +
      'you know exactly what it stalled on.',

    spendTitle: 'What it cost',
    spendCaption:
      'Spending is shown in tokens — visible without an API subscription. You can ' +
      'switch it to money in the panel settings.',
    spendRun: 'The badge in the header',
    spendRunText:
      'The current run: tokens or dollars, depending on the chosen unit. It updates ' +
      'as the answer streams.',
    spendSession: '“Session total” in the agents panel',
    spendSessionText:
      'Everything across all runs in the session. The server keeps the count, so ' +
      'reloading the tab does not reset it — the client just pulls the value again.',
    spendLimit: 'The limit badge',
    spendLimitText:
      'Appears only when a limit was hit: it shows when the limit resets. How much of ' +
      'the limit is left cannot be found out locally.',
    spendStep: 'The numbers to the right of an action',
    spendStepText:
      'The price of every step, right in the feed: the muted number is the whole ' +
      'volume that went through the model, the accented one is the new work of that ' +
      'step (fresh input, cache writes, generation). They are split because the full ' +
      'volume is roughly the size of the context on almost every step and consists ' +
      'mostly of cache reads: a cheap action cannot be told from an expensive one by ' +
      'it. Hover the numbers for the breakdown by token kind with shares, the model ' +
      'of that step and the cost at its rate; a click pins the panel. The model ' +
      'counts spend per STEP, so several calls made at once share one number — the ' +
      'panel says so outright instead of splitting it evenly. The third column is ' +
      'the step time: how long the agent took to reach this action since the previous ' +
      'record of the run; the last block of an answer also carries the whole run (Σ), ' +
      'and while an answer is being written a live counter runs under it. Old records ' +
      'without a timestamp get no column.',

    recipesTitle: 'How to start working with a project',
    recipe1: 'Open the project',
    recipe1Text:
      'The “Chats” tab → the “Projects” section → the project you need. Not in the ' +
      'list? Use “Add a folder” and pick the directory on disk.',
    recipe2: 'Check the edit toggle',
    recipe2Text:
      'It is in the “Chat settings” menu on the right of the header and switched on ' +
      'by default. To look around first, move it ' +
      'to read-only: the field already holds a question about the project, so send ' +
      'it as is.',
    recipe3: 'Give the task',
    recipe3Text:
      'Once it is clear what to change and where, switch edits back on. The toggle ' +
      'keeps that position until you change it again.',
    recipe4: 'Go do something else',
    recipe4Text:
      'The run does not stop when you switch tabs. When a background agent finishes, ' +
      'asks a question or fails, a notification arrives in its own colour — green, ' +
      'yellow or red. Clicking it opens the project in question.',

    notesTitle: 'Things people trip over',
    noteTabTitle: 'Reloading the page does not kill the agent',
    noteTabText:
      'The process belongs to the server, not to the tab: closing the tab or pressing ' +
      'F5 only detaches the listener. Come back and a running job is picked up, with ' +
      'the stream catching up on what you missed. The accumulated session spend now ' +
      'survives a reload too: the server keeps the count and the tab just pulls it. A ' +
      'run that finished while the page was away never shows as running, not even for ' +
      'a second: its answer is already in the conversation history, and the panel only ' +
      'pulls the tail — cost, tokens and the question, if the agent asked one. A tab ' +
      'keeps at most three live streams: the open conversation, runs waiting for an ' +
      'answer and the branches of the open one come first, the other running jobs are ' +
      'followed by polling and get a stream as soon as a slot frees. That is why a ' +
      'message into a seventh conversation goes out at once instead of waiting in the ' +
      "browser's connection queue.",
    noteQuestionTitle: 'An option is picked with a click',
    noteQuestionText:
      'The card draws the options as buttons: a click sends the chosen text as an ' +
      'ordinary message into the same conversation. A busy agent is no obstacle — it ' +
      'asks mid-turn and keeps working, and the answer waits its turn in the queue ' +
      'above the composer. If none of the options fits, type your own answer as usual.',
    noteOutsideTitle: 'A question calls even from a conversation the panel did not start',
    noteOutsideText:
      'The dot, the browser badge and the sound are raised from the transcript, so ' +
      'an agent in a terminal or a neighbouring window calls too: the sound plays ' +
      'once per new question, and the dot stays until you answer. A permission ' +
      'request is not visible this way — it lives only inside the process and never ' +
      'reaches the transcript before it is decided, so the panel knows about it only ' +
      'for its own runs.',
    noteArtifactsTitle: 'The list of created files exists only for chats outside a project',
    noteArtifactsText:
      'Inside a real project the panel deliberately does not show it: dumping a ' +
      'whole repository as a list of “created files” would be useless.',
    noteLimitTitle: 'Spending is shown per run, not for all time',
    noteLimitText:
      'The badge in the header is the current run; “session total” in the agents ' +
      'panel is everything since the page loaded. History across days and the ' +
      'breakdown by model live in the Analytics section.',
    noteMemoryTitle: 'A background agent’s answer is in the history, not the stream',
    noteMemoryText:
      'When a background run ends, the panel frees memory and drops the accumulated ' +
      'stream: the answer is already saved in the transcript. The status and any ' +
      'error text stay.',
    noteHistoryTitle: 'The last 400 messages are shown',
    noteHistoryText:
      'Very long conversations are trimmed from the top: transcripts run to hundreds ' +
      'of megabytes, and there is nothing to read them whole with in a browser.',
    noteRestartTitle: 'A panel server restart does not kill the agent — the run is picked up',
    noteRestartText:
      'Agent processes outlive a restart of the panel server, while the run registry ' +
      'used to live only in memory: after a restart every permission request was ' +
      'refused with "Conversation not found" and no card appeared in the chat. Running ' +
      'runs are now recorded in a ledger on disk (runs.json in the panel data folder), ' +
      'and on start the server picks up the ones whose process is alive: permission ' +
      'cards are drawn in their chats, Stop works, the end is detected by the process ' +
      'dying. What a picked-up run lacks is its output stream: the answer is read from ' +
      'the conversation, and the feed says so in a line. When the run ends the panel ' +
      "reads the agent's last completed turn out of the conversation — both a clean " +
      'session continuation and the work → review → fix pipeline follow from it; a turn ' +
      'cut short on a tool call does not count as a closing one, and then there is ' +
      'nothing to decide by. A run missing from the ledger is looked up there once more ' +
      'right on the permission request, and only then refused — "the panel restarted, ' +
      'send the message again" — the same text showing in the conversation as the call ' +
      'result.',
    noteLiveTitle: 'A conversation running outside the panel is picked up on its own',
    noteLiveText:
      'The same chat can be driven from a terminal or an editor extension — such a ' +
      'turn has no event stream of its own. The feed still updates: the server ' +
      'watches transcript files and reports changes, and the panel additionally asks ' +
      'for the fingerprint of the open conversation every few seconds — in case file ' +
      'watching is switched off in settings or the stream broke. No page reload needed.',
    noteProviderTitle: 'Other providers have a chat of their own',
    noteProviderText:
      'With a non-Claude provider active, the Chat section shows its own chat: a list of ' +
      'conversations, memory between questions, the reply as the CLI prints it, a working ' +
      'directory and file attachments by path. The panel keeps the transcript there — these ' +
      'CLIs have no readable history of their own — and the context of the next question is ' +
      'assembled from it. Every answer carries its time: how long the run took and the sum ' +
      'over the conversation. The panel measures it on its own process, so it is there for ' +
      'every CLI — unlike spend, which not all of them report and never the same way. ' +
      'What is missing: parsed steps and tools, cost, branching, voice and ' +
      'parallel agents — all of that is read out of the claude streaming protocol, and no ' +
      'other CLI publishes such a format. OpenCode holds a session (opencode serve) instead ' +
      'of a run per question, so its answer arrives whole. The Aider, OpenCode, Continue, ' +
      'Goose and Kimi Code chats are built from the docs and have not been exercised live — ' +
      'those CLIs are not installed on the development machine. Cursor has neither a ' +
      'non-interactive entry point nor a model API of its own.',
  },
  shots: {
    basics: {
      '01-project-empty':
        'An empty conversation in the project folder: header, git strip and prompts at hand',
      '02-composer': 'A question with a file attached — the attachment shows as a chip',
      '03-answer': 'The answer as it is generated: thinking, tool calls, spend, text',
      '04-permission': 'The agent stands on a call and waits for a decision: deny or allow',
      '05-question': 'The agent asks: three questions in a row, the next opens after an answer',
      '06-branch': 'The git strip expanded: changed files, pull and push, branches and copies',
      '07-menu': 'The conversation menu: permission toggles and the rules that skip the card',
      '08-menu-actions': 'The bottom of the same menu: session restart, export, refresh, help',
      '09-agents': 'The agents panel: who is running, whose spend, and one stop button',
      '10-handoff': 'A stage is closed: an offer to continue in a clean session from a file',
    },
    split: {
      '01-proposal': 'An offer to split: three groups, branches, kind of work and model',
      '02-tree': 'After the split: links in the list on the left and the hub in the parent feed',
      '03-hub': 'The hub: chain stages, model, time at work and the branch comparison button',
      '04-child-ask': "A child's permission request lands in the parent with the group name",
      '05-overlap': 'Branch overlap: a shared file and a file taken outside the group it owns',
      '06-paused': 'The tree on pause: a mark on every group and the resume button',
      '07-worktrees': 'Parallel copies of the repository: path, install trace and removal',
    },
  },
  diagrams: {
    'message-path':
      'The path of one message: composer to panel server to CLI process to the transcript on disk, and the answer back as a stream. The panel has no database of its own.',
    'split-conveyor':
      'What happens after Split: triage, plan, work and review by stage — and where the human decides.',
  },
};
