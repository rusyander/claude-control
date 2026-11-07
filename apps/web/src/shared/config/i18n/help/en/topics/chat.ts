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
      'Write to the agent while it works, as in Claude Code itself: the message goes ' +
      'out at once, the agent reads it at its next step (after the current tool ' +
      'call), answers, adds it to the plan or changes course, and carries on with the ' +
      'same turn — no waiting for it to end. In the feed such a message is a faint ' +
      'bubble marked “passed to the agent — it takes it into account at the next ' +
      'step”. In a chat on another CLI a word sent mid-turn gets its answer as a turn of ' +
      'its own in the same run: the answer sits under that word, not appended to the ' +
      'previous one. A message with attachments queues up instead: a bubble marked “goes ' +
      'out next” that survives a page reload and goes out as soon as the current turn ' +
      'ends; the previous turn’s answer stays in the feed meanwhile, and after a page ' +
      'reload mid-turn every message and every answer appears once',
    canProgress:
      'Watch the agent’s plan: the strip above the input shows its own checkpoints ' +
      '(what is done, what is in progress) and the tree of subagents it handed work ' +
      'to, along with what each returned. If the turn ended with a question for you, ' +
      '“Waiting for your answer” comes first in the strip. A background command the ' +
      'agent stopped itself (dev-server cleanup) is marked “stopped by the agent”, not ' +
      '“cut off”. Subagents form a tree: one launched by a subagent sits under it, an ' +
      'arrow folds the branch. Each node shows the model, number of calls, token ' +
      'spend and time from the core journal (spend the core does not know is not ' +
      'shown); a running one shows what it is doing now. A click or Enter opens the subagent on the right ' +
      'from the core journal: model, brief, spend, calls, files, refusals and what it ' +
      'returned — read-only, Escape closes it and returns to the node. Arrow keys walk ' +
      'the tree: up and down — siblings, left — fold or go to the parent, right — ' +
      'unfold or enter the nested one. A subagent has no “Stop” of its own: the core ' +
      'session host holds the CLI process, so only the whole turn stops — “Stop” in ' +
      'the input. Below the strip, the “Agents” card counts background work running ' +
      'now (“background: 2” or “no background work”) and opens a window with every ' +
      'agent of every task of the chat — sessions, subagents, background commands — ' +
      'with filters and export. A background command opens in detail: the command, ' +
      'its output, whose it is and how it ended — “finished (code 0)”, “orphaned”, ' +
      '“hanging”; the output tail starts at a whole line. Background work the core first ' +
      'saw late (after its own restart) is named orphaned but not stopped. Quiet ' +
      'background work that listens on a port is a server and never gets “hanging”. A ' +
      'subagent of a session that ended without its own end is “lost”, with the ' +
      'session’s end time. A group card shows how many of its agents run and how many are ' +
      'done, a label for each and the same “Agents” button over the group’s tasks. ' +
      'All of it is the core journal: the panel does not read CLI transcripts for ' +
      'this, so the window is the same for a chat on any CLI',
    canChatDots:
      'Tell conversations apart by the dots in the chat list: a project can hold ' +
      'several agents, and it is visible which one is waiting for an answer',
    canVolume:
      'Hear the agent louder: the agents panel has a notification volume (200% by ' +
      'default), and the browser tab icon and title get a dot when an agent asks, ' +
      'needs a permission or fails while you are in another app; looking at the ' +
      'panel clears it, a new reason sets it again',
    canOpenFolder: 'Open any folder as a project, even one Claude has never worked in',
    canAttach: 'Attach files by dragging them in, with the paperclip or by pasting a shot (Ctrl+V)',
    canVoice: 'Dictate a request by voice',
    canStop: 'Stop the running turn',
    canEditor: 'Open the project in your code editor with one button',
    canCode: 'View and edit project code inside the panel, with a diff of the agent’s edits',
    canTests: 'See the project’s test cases, edit them and have the agent run them',
    canContinue: 'Continue any past conversation, including ones started in the terminal',
    canFork:
      'Branch the conversation: editing your own message goes off as a new branch ' +
      'instead of appending to the same one. Before sending, the panel asks “Send as a new ' +
      'branch?”; clear the field and the mark is dropped, so the message goes into the same ' +
      'conversation. In the list the branch is labelled “branch of …” with the original’s title ' +
      'in place of the project: it keeps the same title, while groups, the pin and links stay with the original',
    canRetry: 'Repeat a failed request with one button, without retyping it',
    canSpend: 'See what a run cost — in tokens or in money, your choice',
    canAnswerButtons: 'Answer an agent question by clicking an option',
    canModel: 'Pick a model and thinking depth — for the whole panel or for one chat',
    canApprove: 'Allow or deny a specific action right in the conversation',
    canSearchMessages:
      'Search the body of a conversation, not just its title and preview: the ' +
      '“By messages” switch in the chat list, with matches highlighted',
    canPin:
      'Pin a top-level conversation with the pin in its row: it sits under “Pinned” above ' +
      'everything else, and the group chats split from it ride along with it',
    canLoadMore:
      'Load earlier messages with the “Load more” button — a long conversation is ' +
      'not cut off at the last window',
    canExport: 'Export a conversation to a file — Markdown or JSON',
    canRun:
      'Start the project’s dev server or back end right from its chat tab and jump to the ' +
      'address the server printed itself; in a monorepo — one target per package, several ' +
      'at once, and the ones you need together with a single “Start all”',
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
      'Cut short a step already under way with an added message: the agent reads ' +
      'it after the current tool call, so a long command runs to its end — only ' +
      'Stop halts it at once. With other CLIs the addition goes out only when the ' +
      'turn ends',
    cantGallery:
      'Keep a gallery of images and presentations: the panel holds the last hundred of each on ' +
      'disk and shows no history of them — save what you need with «Download» right away',

    storageTranscripts: 'Transcripts',
    storageTranscriptsValue: '~/.claude/projects/<project-path>/<sessionId>.jsonl',
    storageWhatRuns: 'What is launched',
    storageWhatRunsValue: 'claude -p --input-format stream-json --output-format stream-json',
    storageSandbox: 'Chats outside a project',
    storageSandboxValue: '~/.agentdeck/chats/<chat id>/',
    storageImages: 'Drawn images',
    storageImagesValue: '~/.agentdeck/media/<id>.png (or .svg) with <id>.json beside it',
    storageDecks: 'Assembled presentations',
    storageDecksValue: '~/.agentdeck/media/decks/<id>.{json,html,pptx,pdf}',
    storageStream: 'How the answer arrives',
    storageStreamValue: 'as an SSE stream — text appears as it is generated',
    storageSteer: 'A message mid-turn',
    storageSteerValue:
      'a line on the stdin of the same process; the transcript holds an attachment ' +
      'record of type queued_command, and the feed shows it as an ordinary message',

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
      'if there is none it says so: HTML and PPTX do not disappear with it. The HTML is ' +
      'always light: a dark browser theme or Dark Reader does not recolour it, and the lock ' +
      'is added to decks built earlier as they are served. The mode request shows short in ' +
      'the feed — «Presentation: topic», «Presentation edit: request» or «Image: topic», ' +
      'with its rules ' +
      'folded under a click; the chat is named the same. The panel agent starts such a chat ' +
      'too when asked for a presentation or a picture — without a project.',
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
      'behind all those decisions live in «Prompts», in the «Presentation» text, and you can ' +
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
      'The «Rework» button on a deck card turns the field into a rework: «make the third slide ' +
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
      'through the core, the same road the CLI requests of this contour take: the request is in ' +
      'the journal, passes data protection, a contour refusal arrives as a readable reason, and ' +
      'it counts toward the key’s spend when the contour sent usage. The core gateway switch is ' +
      'not needed for this. The core never retries a paid image: a temporary contour refusal ' +
      'comes back as a refusal, not as a second charge. The endpoint profile is your own address, ' +
      'not the corporate key, so it goes directly, bypassing the core: its requests are in ' +
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
      'address, that API kind has no such endpoint. Then the item works by the ' +
      'agent road, and the raster’s reason stands beside it — which is what can be fixed. If the ' +
      'core did not answer or did not accept the contour at the moment of the request, the image ' +
      'is not drawn, and the refusal names the reason in the core’s words.',
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
    diffForeign: 'One chat for every CLI',
    diffForeignText:
      'There is one chat: a new conversation runs on the active provider’s CLI, and a started ' +
      'one stays on its own CLI even if the provider changes later. The chat has no CLI ' +
      'picker and no separate screen for Codex, Qwen Code, OpenCode and the rest. Chats of ' +
      'other CLIs behave like Claude chats: earlier answers stay in the feed, the history ' +
      'survives a page reload, the chat is in the list on the left (and in the project list ' +
      'on the phone), and reopened from the list it continues the same session.',
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
    undoWorktree: 'Remove a copy of the repository',
    undoWorktreeText:
      'Remove sits under the copy card in the git strip. While an agent is running ' +
      'inside the copy the panel refuses — stop its run first.',
    undoHandoff: 'Decline the continuation',
    undoHandoffText:
      '"Stay here" on the stage card. Auto-continue is switched off by the "carry ' +
      'on yourself" toggle in the same place and is remembered.',
    undoCascade: 'A turn on exactly your model',
    undoCascadeText:
      'The core picks the step model. To make a turn run exactly on your model, choose it in ' +
      'the conversation header: the core never lowers a model override and never raises an ' +
      'effort you set.',
    undoChat: 'Delete a conversation',
    undoChatText:
      'Not from the panel, and deliberately so: the transcript belongs to Claude ' +
      'Code, not to the panel. It can only be deleted where it lives.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'The diagram answers what no screen state shows: where a message goes and who starts the CLI.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The input hands the message to the panel server, but the server does not start the CLI process itself: ' +
        'the task core runs the turn. If a core step already holds the conversation, the message goes to that ' +
        'step, and the core delivers it at the turn boundary; the turn does not end until the added words have ' +
        'reached the CLI, so the reply to them comes in the same turn. If the step has already ended or the core ' +
        'did not accept the message, there is no delivery to wait for and the turn closes as usual. ' +
        'Otherwise the core gets a new «chat» task right in ' +
        'the project folder (starting the chat is your edit grant for that root), resuming the conversation if ' +
        'there was one, then the CLI choice, the turn model and the launch. The core session host starts claude; ' +
        'the core holds the process, so a panel restart does not touch it. The CLI writes the conversation to its ' +
        'transcript on disk, and the server reads the running turn from the core session view and streams it to ' +
        'the feed. The panel has no conversation database of its own: history is read from the transcript, so a ' +
        'conversation from the terminal shows here and one started here shows in the terminal. The core writes a ' +
        'permission question to the task journal, the panel shows it as a card with the «Core question» badge ' +
        'and the question text, and the step waits for the decision; a child subagent’s question stands as the ' +
        'same card in the parent window. The model retrying the same call raises no new question: a pending one ' +
        'stays single, and on an answered one the core applies your answer itself. Telegram only reports such a ' +
        'question; it cannot be answered from there. The chat window itself sends the answer to the core, as a command stamped with its page: ' +
        '«Allow» on an edit the core closed without a grant gives the task a grant for that path and answers ' +
        '«grant», «Deny» refuses; the panel server may not answer the core. From the phone the same question ' +
        'is answered on the «Questions» screen: the phone sends the core the grant and the answer as a command signed with ' +
        'the device key; without a paired key no answer leaves and the card names the reason. ' +
        'In such a chat the «Permissions auto» ' +
        'toggle is an edit grant for the whole task repository, given by the same window, so item-5 questions ' +
        'stop coming. Under a running subagent line: what it is doing now; beside it: how long it has worked in ' +
        'total. Core not running: the feed shows the reason; a core refusal of the turn comes in interface ' +
        'words: the required contour is unavailable, the route needs a model, or a general refusal with the ' +
        'core code (its own words are in the task journal). A turn that ends with an error of the CLI itself ' +
        'shows it in the CLI’s words — for example, that the prompt is too long; a generic phrase only when the ' +
        'CLI gave none. There is no silent fallback to the old path.',

      basicsTitle: 'One conversation from start to finish',
      basicsCaption:
        'Shot on the "Orders panel" project in C:/work/orders-panel: a conversation ' +
        'about exporting orders to CSV.',
      bEmpty: 'Open the project and start a conversation',
      bEmptyText:
        'The project tab, the New chat button — an empty conversation right in that ' +
        'tab. The first message creates a core task on the active provider’s CLI, and ' +
        'the conversation runs in the project folder, with no copy. A link like ' +
        '/chat?project=<folder> opens that project’s tab straight away. ' +
        'The start reaches the core through the panel: it adds its own layer — the ' +
        'kit and the Tests block line, plus for Claude the flags of its own layers and ' +
        'the profile note — and sets the contour route before the CLI (“Chat” for ' +
        'Claude, its own route for another CLI), so the “best effort” contour carries such a conversation ' +
        'too. If the core refuses the launch (for example, the CLI has neither a ' +
        'pre-call hook nor core denials), the feed shows a refusal line with the code ' +
        'and the input goes away; there is no silent fallback to the old path. If the layer cannot be ' +
        'carried into the session, the start is refused with the reason, and a kit ' +
        'refusal during a turn (hooks, MCP, kit missing) names the cause and the way ' +
        'out — in the panel and on the phone. A folder without the CLI’s trust mark ' +
        'does not switch the kit off: it lives in the panel’s directory, not in the ' +
        'repository. ' +
        'Earlier conversations of the project still open and continue in the ' +
        'project tab — the rest of the path is shown on one of them.',
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
        'call: the card is a fork, not a notification. It waits for almost a day — as ' +
        'long as the CLI holds one call; if the CLI stopped waiting earlier, an answer ' +
        'to the card gets "The request has already expired" and starts nothing.',
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
      bMenu: 'Permissions and actions are in the Chat settings menu',
      bMenuText:
        '"Permissions auto": the window itself gives the core an edit grant for the task ' +
        'repository, so no permission questions come up; "Permissions manual": every path ' +
        'is asked with a card. "Edits allowed" switched off leaves the agent read-only. ' +
        'Below: restart the session, export, refresh and open this help. Restart is greyed ' +
        'out while a run is going — wiping the context mid-move means losing the move.',
      bAgents: 'Watch every agent at once',
      bAgentsText:
        'The header panel says "3 active agents", each row telling where it works ' +
        'and in what state (waiting for an answer versus working), the project one ' +
        'showing 111.3k tok and claude-opus-5. Stop all kills them in one press.',
      bTree: 'Look into the plan of the agent and its subagents',
      bTreeText:
        'The “The agent’s plan” strip above the input: the plan steps and “Work handed out” — ' +
        'subagents as a tree, the test check nested under the review that launched it. A click ' +
        'on a subagent opens it on the right. Below the strip sits the “Agents” card with ' +
        '“background: 1”: how many background commands and background subagents run right ' +
        'now; nothing running reads “no background work”. Chats on any CLI get the card: it ' +
        'reads the core journal, not a Claude transcript.',
      bHistory: 'Open every agent of the chat',
      bHistoryText:
        '“Agents” opens a window with every node of every task of this chat: the session, ' +
        'subagents and background commands as a tree, each with its state in words ' +
        '(“running”, “failed”, “finished (code 0)”), model and duration. On the right, the ' +
        'selected one shows model and effort, its brief, spend in tokens and window share, ' +
        'tool calls with durations, files, “Permission refusals” with the reason, “Model ' +
        'escalations” with the cause (haiku → sonnet: two test failures in a row) and what it ' +
        'returned. Spend the core does not know reads “unknown”, never zero. Filters cover ' +
        'state, model, kind, task class and group; “Export” saves the journal lines about ' +
        'agents as one jsonl file with secrets masked.',
      bBackground: 'Sort out background work',
      bBackgroundText:
        'A background command opens the same way: the command, start, duration, the tail of ' +
        'its output, whose it is — task, step, session and the call that launched it — and how ' +
        'it ended. “Orphaned — reaped by cleanup” means the owner process went away before the ' +
        'command and the core removed it; “orphaned — lost” — the owner went away but the CLI ' +
        'never named the command’s process id, so the core had nothing to remove; “orphaned” — ' +
        'the owner is gone and the command still lives; “hanging” — the command runs but has ' +
        'been silent for long.',
      bHandoff: 'Continue a closed stage in a clean session',
      bHandoffText:
        'The "stage closed — continue in a clean session" card with the counter ' +
        '"step 1 of 8" carries the checkpoint — here .agent/PROGRESS.md — and what ' +
        'to do next. Continue opens the next conversation with that checkpoint; ' +
        'Stay here leaves everything as it is. When the next step waits for an ' +
        'outside event — "When the MR is merged: …", an answer from a person, a ' +
        'deploy — the panel starts no new session by itself: for a group the step ' +
        'lands under "For you to do" with that event, and the card button continues ' +
        'once it has happened.',

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
      'That is how you start in a folder Claude has never run in. “Open several” ' +
      'opens every project ticked in its list as tabs at once; projects already open ' +
      'stand there ticked and disabled.',
    tabOrder: 'Your own tab order',
    tabOrderText:
      'Drag a project tab to the place you want it, or move it a step at a time ' +
      'from the keyboard with Alt+← and Alt+→; Delete closes the focused tab. The ' +
      'home tab takes no part in the reordering and always stays first.',
    tabsNote:
      'Tabs and their order survive a page reload, and closing a tab closes only ' +
      'the tab — neither chats nor files are touched. Projects from the “Projects” ' +
      'page come first in the list with a pin, even without a single conversation, so ' +
      'closing such a project’s tab does not lose it. Any other project is added there ' +
      'with the “+” button in its row.',

    toolsTitle: 'The project row: dev server and git',
    toolsCaption:
      'The project tab header has two rows. The top one is the conversation: model and ' +
      'effort, the “Local” button (your own GPU instead of the cloud in one click, see the ' +
      '“Local models” help), “Agents”, “Chat settings”. The bottom one is the project: “To MR”, ' +
      '“Project code”, “Tests”, “Environment”, “Editor”, “Dev server” and, last, whether the ' +
      'project is on the “Projects” page: “In Projects” leads to its settings, “To Projects” ' +
      'adds it there in one click. All of it works against the ' +
      'real directory on disk — the panel keeps no copy of the state. In a narrow ' +
      'column the buttons whose icon speaks for itself drop their label and keep the ' +
      'icon and a hover hint.',
    toolsRun: 'Starting the dev server',
    toolsRunText:
      'The “Dev server” button (a server-rack icon) opens the run settings: what to run, ' +
      'the command, the port and “Autostart”. The ▶ triangle next to it runs the ' +
      'command from package.json (dev, otherwise start) or ' +
      'your own — with the package manager the project actually uses: pnpm, yarn or npm. ' +
      'The panel does NOT assign the port: the app comes up on its own, the panel reads ' +
      'the address from its output and opens the browser once the port answers. A ' +
      'monorepo has several targets — “Dev server” lists them, and they can run at the ' +
      'same time. A running server shows in the same row as an “Open :port” link and a ' +
      'stop button. The browser opens only for a front end: Go, Python, Java, Rust and ' +
      '.NET serve an API at that address, not a page, and an empty tab on every start ' +
      'would only get in the way. The panel starts it only for projects in the Projects section, ' +
      'folders inside them and copies of their branches: in any other folder ▶ answers ' +
      'with a refusal, “Add this folder as a project”, and the command does not run. A path ' +
      'with “..” gets the same refusal even when it starts with the project path: the panel ' +
      'does not guess where it really leads. Autostart on panel start is checked the same way.',
    toolsPort: 'Port already taken',
    toolsPortText:
      'When the server refuses to start (“Port 5173 is already in use”), the panel shows ' +
      'who holds the port — process name and PID — and a “Free it and start” button. It ' +
      'kills nothing on its own: a database or a neighbouring project may live there, so ' +
      'the call stays yours. A port can also be pinned in the target’s settings — then the ' +
      'panel passes PORT and waits for exactly that one, and passes it to a back end the ' +
      'way its stack expects too: uvicorn’s --port, Django’s address, Spring’s SERVER_PORT, ' +
      '.NET’s --urls. Go and Python complain about a taken port in their own words ' +
      '(“bind: address already in use”) — the panel recognises that as well.',
    toolsStacks: 'Back end: how to run it',
    toolsStacksText:
      'Besides package.json the panel recognises Go (go.mod; programs under cmd/ are ' +
      'separate targets, run from the module root), Python (FastAPI and Flask through ' +
      'uvicorn/flask, Django through manage.py; uv, poetry or .venv when present), Java ' +
      '(Gradle and Maven, with the project’s gradlew/mvnw wrapper), Rust (cargo run), .NET ' +
      '(dotnet run), Deno and make, task and just tasks named dev, run, serve, start. ' +
      'Services are found outside workspaces too — in services/, apps/, backend, server, ' +
      'api, worker. A target shows its stack (“Go”, “FastAPI”) and a “Found by: …” line — ' +
      'the files the command was guessed from. When there are several ways (Django has both ' +
      'make run and manage.py runserver) they are listed: a click saves the choice at once, ' +
      '“Back to automatic choice” clears it. When the needed program is missing the target ' +
      'does not run, and the panel names the program BEFORE the start instead of showing ' +
      '“process exited with code 1”.',
    toolsGroup: '“Start all”',
    toolsGroupText:
      'A back end is rarely one process: API, worker, front end. When there is more than ' +
      'one target, each row starts with an “In ‘Start all’” tick — tick the ones you need ' +
      'once and the set is remembered for the project. “Start ticked” brings them up in ' +
      'one request; one target’s refusal does not stop the rest and arrives as its own ' +
      'message with the reason. While the set is not fully up, ▶ in the bar starts it too, ' +
      'without the popover — its hint names the targets. “Stop all” stops everything the ' +
      'panel started in this project, not just the set.',
    toolsAutostart: 'The “Autostart” toggle',
    toolsAutostartText:
      'It is not about now but about the panel’s next start: a ticked target comes up ' +
      'by itself, with no browser window and no navigation. Close the project tab and the ' +
      'toggle clears on all of its targets. It can be switched on within the same bound ' +
      'as ▶: only for a project in the Projects section or its copy. A mark left on a ' +
      'folder outside the projects does not start at launch: the panel server’s output ' +
      'shows an autostart failure naming the folder and asking to add it as a project.',
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

    envTitle: 'Project environment: Docker Compose services',
    envCaption:
      'The “Environment” button (layers icon) in the project row opens a window with ' +
      'what the backend cannot run without. The “Services” tab lists the containers from ' +
      'the project’s Docker Compose. The panel stores nothing: the stack comes from the ' +
      'file (docker compose config), the state from docker (docker compose ps), and the ' +
      'window refreshes itself while open.',
    envFind: 'Where the panel looks for the file',
    envFindText:
      'compose.yaml, compose.yml, docker-compose.yaml or docker-compose.yml — in the ' +
      'project root, then in the docker/, deploy/ and .docker/ folders. Docker applies ' +
      'an override next to the file (compose.override.yaml) on its own — the window ' +
      'names it beside the main one. Commands run from the file’s folder without -f, ' +
      'exactly as from a terminal, so the window sees the same containers and the same ' +
      'project name as docker compose ps in your console.',
    envStates: 'What the table shows',
    envStatesText:
      'Services come in start order: the database above the application that depends ' +
      'on it. Each has its image (or “built from source”), state and ports. The state ' +
      'accounts for the health check: “Running, healthy”, “Starting”, “Running, health ' +
      'check failing”. A container stopped by a button reads “Stopped” even when docker ' +
      'recorded exit code 137; “Crashed, code N” is a real crash only. A running ' +
      'service’s port is a link: 5433 → 5432 means the database waits on 5433 on this ' +
      'machine.',
    envActions: 'Start, stop, restart',
    envActionsText:
      '“Start all”, “Stop all” and “Restart all” act on the whole stack; the buttons in ' +
      'a row act on one service (starting a service starts its dependencies too). One ' +
      'action runs on a stack at a time: while it runs the buttons are off and the ' +
      'docker compose output shows under the table. If it fails the output stays open: ' +
      'the reason (“port is already allocated”, “pull access denied”) is in the last ' +
      'lines. Starting and removing work only for projects from “Projects” and their ' +
      'copies — the same boundary as the dev server; viewing works anywhere.',
    envRemove: 'Removal and data',
    envRemoveText:
      '“Remove containers” is docker compose down: the stack’s containers and network ' +
      'go, data in named volumes stays, and the next “Start all” creates the containers ' +
      'again. “Remove with data” is down -v: the volumes go too. Before that the window ' +
      'asks again and names the volumes one by one — the databases, uploads and caches ' +
      'in them do not come back.',
    envNotReady: 'When nothing can be started',
    envNotReadyText:
      'The window explains each such case itself. No docker program — “Docker is not ' +
      'installed” and what to install. The program is there but its service does not ' +
      'answer — “Docker is not running”: start Docker Desktop or the docker service, ' +
      'the window refreshes without a reload, and docker’s answer is under “What docker ' +
      'said”. No file in the project — the window lists where it looked. A file docker ' +
      'rejected — its answer is shown verbatim, with the line and key it tripped on.',
    envNote:
      'A closed window does not poll docker. An action started in the window runs to ' +
      'the end even after it closes — reopen the window to see its result and output.',

    dbTitle: 'Project environment: the database',
    dbCaption:
      'The Database tab shows the project’s Postgres: schema, data, query plans and ' +
      'migrations. Everything is read-only: the panel never changes a row or a table, and the ' +
      'same limit applies to the agent.',
    dbFind: 'Where the connections come from',
    dbFindText:
      'The panel reads the project’s files: a Postgres service in Docker Compose (the port ' +
      'published on this machine plus POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB), .env files ' +
      '(DATABASE_URL, PG*, DB_*) and Spring settings (application.properties and .yml). One ' +
      'database named in several places is one line in the list; a db:5432 address from the ' +
      '.env of an app running in a container is mapped to the published port. A database ' +
      'elsewhere is added with «Own connection»: its password is stored encrypted in the panel ' +
      'and never handed out.',
    dbQuery: 'Schema and queries',
    dbQueryText:
      'On the left are the tables with columns, types and an approximate row count; search ' +
      'finds both tables and columns, and «Insert a query» puts a SELECT into the editor. Run a ' +
      'query with the button or Ctrl+Enter: one statement, up to 500 rows, 15 seconds. The ' +
      'result shows the type under each column name and tells NULL from an empty string. On ' +
      'an error the window names the line and puts the cursor where Postgres stumbled. «Plan» ' +
      'is EXPLAIN without running, «Plan with execution» is EXPLAIN ANALYZE with timings.',
    dbSafe: 'Why nothing can be written',
    dbSafeText:
      'Two layers. First the panel looks at the text: a query must start with SELECT, WITH, ' +
      'EXPLAIN, SHOW, TABLE or VALUES, and modifying words and functions acting outside the ' +
      'query are refused before sending — «Query not sent». Then every query runs in a READ ' +
      'ONLY transaction that is rolled back: even a function writing from inside a SELECT is ' +
      'refused by Postgres itself. For a shared or production database create a read-only ' +
      'role — an address not on this machine is flagged separately.',
    dbMigrations: 'Migrations',
    dbMigrationsText:
      'The panel recognises golang-migrate, goose, dbmate, sqlx, Prisma, Flyway, Alembic, ' +
      'Django, Rails and Knex, compares the migration files with the tracking table in the ' +
      'database and names the ones not applied. The block opens itself when something is off: ' +
      'pending migrations, a previous one that failed halfway (dirty), or a version in the ' +
      'database with no file. Applying migrations is the project tool’s job, not the panel’s.',
    dbAgent: 'Agent access',
    dbAgentText:
      'The switch at the bottom of the tab writes the panel’s MCP bridge into the CLI ' +
      'configuration. The agent gets the schema, read queries, plans and migrations of the ' +
      'current project under the same limits; the database address and password are not ' +
      'passed to it. Picked up on the next CLI start.',
    dbNote:
      'Only Postgres is read. MySQL, MongoDB, Redis and other databases found in the files are ' +
      'listed under «Found but not readable». A stopped database service in Compose is noticed ' +
      'and the window leads to the Services tab.',

    apiTitle: 'Project environment: API',
    apiCaption:
      'The «API» tab sends requests to the project service and checks the response against its ' +
      'OpenAPI contract — without leaving the chat and without Postman. A mismatch goes to the ' +
      'agent with one button.',
    apiFind: 'Where the contract comes from',
    apiFindText:
      'The panel looks for openapi and swagger files (JSON and YAML) in the project up to 4 ' +
      'levels deep, skipping node_modules and builds, and asks services started from «Dev ' +
      'server» at the known addresses: /openapi.json, /v3/api-docs, /swagger.json and similar. ' +
      'Your own contract address is added with «Add address» — the panel checks that there is a ' +
      'contract there. A Postman 2.x collection comes in with «Import Postman», with collection ' +
      'variables substituted.',
    apiSend: 'Request',
    apiSendText:
      'Pick an endpoint on the left — path and query parameters, headers and body are already ' +
      'filled with examples from the contract. «Fill with sample» puts random values from the ' +
      'schema into parameters and the JSON body — new ones on every click; rows you added ' +
      'yourself stay untouched. «Own request» — address and method by hand. The ' +
      '«Goes to» line shows the final address; Ctrl+Enter sends. The request leaves from the ' +
      'panel server, not the browser, so CORS does not get in the way. The response is awaited ' +
      'for up to 30 seconds, the body is shown up to 2 MB.',
    apiCheck: 'Schema check',
    apiCheckText:
      'A response to an endpoint request is checked against the contract schema for the status ' +
      'that came: «matches» or a list of differences — wrong type, missing required field, value ' +
      'not in the list, extra field, wrong format. A status the contract does not describe is ' +
      'named separately. «Ask the agent about the difference» puts a request with the endpoint ' +
      'and the differences into the chat field — you send it yourself.',
    apiAuth: 'Base address and authorization',
    apiAuthText:
      'The environment comes from the folder of the current conversation. Base address ' +
      'suggestions are the running services of the project, stand addresses from its .env files ' +
      '(keys with passwords and tokens are not read; a task copy without its own .env takes ' +
      'them from the main copy, marked as such) and the contract servers. A click on a ' +
      'suggestion saves the address for the project. When a service does not answer, the panel ' +
      'names the cause: name not found in DNS, port closed, TLS error. The authorization header (a Bearer token, for example) is stored encrypted ' +
      'in the panel data and added by the server: only a mask reaches the browser and history.',
    apiHistory: 'History',
    apiHistoryText:
      'The last 50 requests of the project, with the response status and a mismatch mark. A ' +
      'click opens the request again: an endpoint request — with path fields filled. Masked ' +
      'headers are not repeated — the saved authorization is used instead.',
    apiNote:
      'Ports forbidden by the fetch standard (6000, 6665–6669, 10080 and others) are not called, ' +
      'and the panel says so plainly. «Check contract against code» asks the agent to find ' +
      'endpoints that exist in code but not in the contract and vice versa.',

    logsTitle: 'Project environment: logs',
    logsCaption:
      'The «Logs» tab shows the output of targets started from «Dev server» and of the ' +
      'project’s Docker Compose services in one place: no terminal per process, no manual docker logs.',
    logsSources: 'Where lines come from',
    logsSourcesText:
      'On the left — «Dev server» targets and Compose services with their state. «All services» ' +
      'merges container lines by time and labels each with its service. The panel keeps a ' +
      'target’s output while it lives and its last run after it stops; service lines come from docker.',
    logsLevels: 'Levels',
    logsLevelsText:
      'The panel recognises the level itself: JSON logs (level, severity, pino numbers), ' +
      'level=warn, [ERROR], Spring, Python, nginx. A level button shows that level and everything ' +
      'more severe; its number is how many lines remain. A stack trace stays with its error.',
    logsSearch: 'Search',
    logsSearchText:
      'Case-insensitive, over text and JSON fields, with highlighting and an «N of M» counter. ' +
      'Search and level stay when you switch sources — handy for chasing a request id across services.',
    logsFollow: 'Follow',
    logsFollowText:
      'While «Follow» is on, the view stays at the last line. Scroll up and following turns ' +
      'off, new lines pile up in the «To new lines (N)» button; scroll back down and it turns on again.',
    logsAsk: 'A line to the agent',
    logsAskText:
      'A click expands a line: JSON record fields as a table, «Copy line» and «Analyse in chat». ' +
      'The latter puts the line and up to 20 lines around it into the chat input — passwords, ' +
      'tokens, Bearer values and passwords in database URLs are masked. You send it.',
    logsNote:
      'The tab keeps the last 5000 lines of a source. Logs are shown only for projects from the ' +
      '«Projects» section: they can carry secrets.',

    guardTitle: 'Project environment: backend guard',
    guardCaption:
      'The Guard tab installs a Claude Code hook in the project: before a command that cannot ' +
      'be undone, the agent stops and asks you. Everything else runs as before — no questions ' +
      'on every git status.',
    guardWhat: 'What it asks about',
    guardWhatText:
      'Dropping a table, database or schema (DROP, dropdb, FLUSHALL); TRUNCATE; DELETE and ' +
      'UPDATE without WHERE; rolling back or resetting migrations (migrate down, alembic ' +
      'downgrade, rails db:rollback, prisma migrate reset, flyway clean and others); changing ' +
      'infrastructure (terraform apply and destroy, kubectl delete, apply and exec, helm ' +
      'upgrade); deleting Docker volumes with data. Each rule can be turned off on its own. ' +
      'Reads — kubectl get, terraform plan, SELECT — do not ask.',
    guardProd: 'Production markers',
    guardProdText:
      'A host, an IP or a kubectl context name, one per line. A command containing any marker ' +
      'always asks, even a read — the panel’s auto-approval does not recognise a production ' +
      'address on its own. A marker shorter than three characters is refused: it would match ' +
      'almost every command.',
    guardCheck: 'Check a command',
    guardCheckText:
      'The field at the bottom right tells you whether the guard would ask about a command — ' +
      'using the settings on screen, even unsaved ones. Handy before turning a rule off or ' +
      'adding a marker.',
    guardWhere: 'Where it works',
    guardWhereText:
      'The files go into the project’s .claude/: the hook script, an entry in settings.json ' +
      '(your own entries there are left alone), a rule for the agent and the guard settings. ' +
      'The guard works in the terminal and in the panel chat; in the chat the permission card ' +
      'names the reason, and auto-approval does not let such commands through. Commit the ' +
      'files and everyone working with the repository gets the guard.',
    guardRemove: 'Restore and remove',
    guardRemoveText:
      'If a file is missing or was edited by hand, the tab says “Partial” and names it; ' +
      '“Restore” puts the files back. “Remove the guard”, after confirmation, moves the files ' +
      'into the panel’s backups and returns settings.json to how it was before; the “Backend ' +
      'guard” group in Groups goes with it. Only a person can remove the guard — the agent ' +
      'cannot.',
    guardNote:
      'Only Claude Code reads the hook and the rule. Codex, Gemini and the other CLIs do not see ' +
      'them — the guard will not ask in their chats.',

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
      'project: <project>-worktrees/<branch>. A finished copy opens as a tab at once. The chat ' +
      'no longer offers a copy by itself: there is no “First edit — where do we work?” card — ' +
      'a core task conversation works in the folder it was started in, and starting the chat ' +
      'is the permission to edit there.',
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
      'received ready-made. For the same reason the local layer build .agent/local-layer/build ' +
      'is never copied — the copy builds its own at its first chat. Also never: *.log, files over 8 MB and links. In the mirror ' +
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
      'directory. The e2e autotest folder comes as a link too when the panel created it: ' +
      'it is hidden from git, so a test written in the copy would otherwise vanish with ' +
      'the copy — as a link it lands in the original’s folder and becomes a case there. ' +
      'A project’s own folder in git arrives with the checkout and is never a link. ' +
      'The list is deliberately short — a copy’s settings.json is never a link, ' +
      'or a permission granted in one copy would silently appear in all of them. The ' +
      'mirror report names the linked directories on their own line; if linking failed ' +
      '(file system, rights) the files travel as a copy and the report says so. A ' +
      'linked directory never shows under “left behind”: it is in the copy, just ' +
      'shared with the original.',
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
      'place, does the copy’s .mcp.json carry every server of the original (a file reverted ' +
      'in the copy to its committed version is present but lacks the servers), does the copy’s ' +
      '.claude/settings.local.json carry every hook of the original (a hook added to the ' +
      'original after the copy was made is appended to its entries, the copy’s own entries ' +
      'stay), are the shared directories linked, is there an access entry. If something is missing the ' +
      'panel first fills it in ITSELF and only then, if that failed, refuses and names the ' +
      'gaps: an agent in an incomplete copy does not crash, it silently does the work with ' +
      'the wrong environment, which is worse than a refusal. A split group passes the same ' +
      'check before it starts: a copy that could not be filled in does not start, the ' +
      'reason is on its card, the other groups go on. The same state ' +
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
      'creating a copy” field in “Copy settings”; empty — the panel decides by the ' +
      'lockfiles. In the copy root: pnpm-lock.yaml → pnpm install --frozen-lockfile ' +
      '--prefer-offline, package-lock.json → npm ci --prefer-offline --no-audit ' +
      '--no-fund, yarn.lock → yarn install --immutable. When a folder’s package.json ' +
      'and lockfile in the copy match the original, nothing is installed again. A ' +
      'folder without local packages (no workspace, no file: to a sibling folder) gets ' +
      'node_modules as a link to the original’s node_modules: no disk space, no ' +
      'install; a package the agent installs in the copy lands in the original too. ' +
      'Removing the copy removes only the link. If the original’s node_modules lacks a ' +
      'package its package.json requires, or a version differs from the npm lockfile, the ' +
      'folder is not linked: nothing is installed after a link, and the copy would get ' +
      'incomplete packages — with npm it is seeded instead and the difference installed, ' +
      'as below. A folder with local packages is not ' +
      'linked — the copy would load them from the original instead of its own: with ' +
      'npm its node_modules is built from hard links to the original’s files (no extra ' +
      'disk space) and npm install --no-save runs instead of npm ci, delivering only ' +
      'the difference; bundler caches are not carried over (the original’s tsc memory ' +
      'usually lags behind the copy and only slows its first type check), service folders such as ' +
      '.prisma are copied. None in the root — the same in ' +
      'each first-level folder (frontend/, web/…), up to four at once; a local library ' +
      'its neighbours depend on through file:, whose entry (dist) is not built in a ' +
      'fresh copy, is built with its build script after the install. Without a lockfile ' +
      'the panel does nothing. The command runs through the system shell with CI=1, ' +
      '10-minute ceiling for the whole preparation. The copy’s card shows “installing” / “dependencies ready” / ' +
      '“install failed”, the log and a “Retry install” button. A failure stops ' +
      'nothing: the copy stays. After the command the panel checks the lockfiles (package-lock.json, ' +
      'pnpm-lock.yaml, yarn.lock, bun.lock, plus go.mod, go.sum and uv.lock that the Go and Python warm-up edits): ones rewritten by the install are reverted to ' +
      'the index version, newly created ones are removed, and the list shows on the card ' +
      'and in the log. It looks in the copy root and in first-level directories; a file ' +
      'changed before the preparation (that is the agent’s work) is not reverted. ' +
      'The Node version comes from .nvmrc, .node-version, .tool-versions, volta or engines and ' +
      'the install runs on it when the machine has one (nvm, fnm, volta); when none is found the ' +
      'install runs on what exists and a line under the card says so. The same Node comes first ' +
      'in PATH for the CLI process of every chat in the project, so the agent never hunts for it; ' +
      'an exact .nvmrc version missing from the machine is replaced by the newest one of the same major, not lower. A Python service gets a ' +
      '.venv and pip install from requirements*.txt (uv sync with uv.lock), but only on a ' +
      'matching version; Go gets its module cache warmed; these steps never fail the ' +
      'preparation. A command set under “Copy settings” turns auto-detection off. The full ' +
      'log is kept in a file, and the card and the agent’s task lead with the first real ' +
      'error, not the log tail.',

    cascadeTitle: 'Step model and work in parts: the core runs all of it',
    cascadeCaption:
      'The panel chat no longer splits work into groups or picks models for them: a chat turn ' +
      'runs as a core task with a single “Chat” step. Splitting into parts, the model of every ' +
      'step, review and delivery up to the MR are run by the task core — see the “Core tasks” ' +
      'document. This section covers the rules it follows and what is left of the old splits.',
    cascadeWhat: 'Who picks the step model',
    cascadeWhatText:
      'One core function for every step of every task. Your override is strongest — a model ' +
      'chosen for the step, the part or the whole task; the one closest to the step wins. ' +
      'Without an override the model comes from the route: a contour row that names a model, ' +
      'otherwise the model the CLI uses by default. The choice stays inside the routes allowed ' +
      'for the task; a route that a limit holds or has exhausted is skipped, and the CLI’s own ' +
      'sign-in and local routes are picked before a paid API key. The “why” line in the task ' +
      'timeline says why this model was chosen.',
    cascadeCeiling: 'In the chat: the model from the header',
    cascadeCeilingText:
      'A chat turn hands the core the model and effort from the conversation header as a task ' +
      'override. Through a contour the model name goes as the contour translates it, and the ' +
      'effort is not sent. No model chosen in the header — the core takes the route’s model. ' +
      'The core neither lowers nor raises the “Chat” step: its tier is the chosen model. The ' +
      'header’s model list is the catalog of this chat’s CLI: Claude models for Claude, and ' +
      'for another CLI “CLI default” plus the models of its catalog (on OpenCode and on a ' +
      'contour it can include Claude models too). A Claude model picked earlier does not carry ' +
      'over to another CLI — that CLI runs its own default model.',
    cascadeKinds: 'A step’s tier follows its kind',
    cascadeKindsText:
      'Every step kind has its tier, from one table shared by the core and the scenario ' +
      'editor. Intake, work, review, fixes, reviewer answers, the report, the chat and custom ' +
      'scenario steps run on the chosen model. The plan, the split and research run on the ' +
      'same model with effort raised to xhigh, unless you set the effort. Checks, the final ' +
      'gate, publishing and a question to the human may run one rung lower on the model ' +
      'ladder — only when the model is not your override, the step has mid checks, the lower ' +
      'rung fits the route pattern and this step kind has not failed on it before. A step that ' +
      'failed on the lowered model is redone on the original one.',
    cascadeReview: 'Checking the work: review and fixes are steps of a core task',
    cascadeReviewText:
      'The panel chat no longer opens a review or fixes by itself: there are no “review”, ' +
      '“fixes” or verification links after the work any more. The task core does the checking, ' +
      'as steps of the task scenario. In the ready-made bug-fix, feature, refactor and ' +
      'tracker-ticket scenarios the order is: request intake → plan → work → review → ' +
      'fixes after review → final check → publish. The review runs in a fresh session and only ' +
      'reads: it may not edit files or run shell commands. It gets a pack — the work diff against ' +
      'the base, the task requirements and a summary of the recorded runs — but never the ' +
      'author’s conversation, and the reviewer’s model is never weaker than the author’s. ' +
      'Findings are a list with file, line and severity. No blocking ones → the fixes step is ' +
      'skipped and the task goes on to the final check; some → fixes by that list, then the ' +
      'review again as the next round. There are at most two “review → fixes” rounds; at the ' +
      'limit the core asks you and lists the open findings. In the review-only scenario a ' +
      'report follows the review, and it is published only on request. In “Review an MR by ' +
      'link” you decide after the review: fixes run only if you pick “fix in the copy” or ' +
      '“both”, and sending them to the ' +
      'MR is a separate question after the fixes. The steps and their “why” are in the task ' +
      'feed in the «Core» section. Old conversations with “review” and “fixes” links open as ' +
      'before, with the same labels in the chat list.',
    cascadeLevels: 'Intake, plan and the split into parts',
    cascadeLevelsText:
      'Intake, plan, split, research, review and report are read-only: they may not edit ' +
      'files or run shell commands. The plan runs while the task is being estimated and no ' +
      'part has started yet, and only the plan may propose parts — each with its own paths, ' +
      'dependencies and estimate. The split check judges the proposal. One part — the work ' +
      'runs alone, no split. Two or more need distinct names, known dependencies without ' +
      'cycles, and parts that are not ordered one after another must not own a shared file: a ' +
      'shared file means merging the parts or ordering one after the other. A review of one MR ' +
      'is not split. A refusal names every problem at once, so the plan redoes the proposal in ' +
      'one round. Not refusals but notes: parts beyond the free slots or the window wait in the ' +
      'queue, a part larger than three medians of the estimates gets a resplit suggestion. The ' +
      'core shows an accepted split before launch: by default it asks you (the “launch” ' +
      'question), with the “auto” launch policy it starts on its own, and an auto start that ' +
      'fails the preflight turns back into the question. Every part gets its own copy and ' +
      'branch — from the task’s pinned base or from the branch of the part it follows.',
    cascadeHub: 'Where to watch the work',
    cascadeHubText:
      'In the “Core tasks” section. The task timeline shows the steps per part, the model of ' +
      'every step and the “why” of every decision; the core’s questions live there too — ' +
      'launch, round cap, permission, model question. There is no group summary under the ' +
      'agent’s answer for new work: the chat no longer starts children.',
    cascadeDelivery: 'Delivery up to the MR is the core’s publish step',
    cascadeDeliveryText:
      'Only the core pushes the branch and opens the MR. The model session cannot push: the ' +
      'copy’s push URL leads nowhere, the pre-push hook and the ssh wrapper refuse, and push, ' +
      'MR and forge writes are denied in the session’s permissions with “platform step, the ' +
      'core publishes”. Before publishing comes the final gate: every requirement of the task ' +
      'is covered. Readiness is judged by one function that refuses with one list of every ' +
      'unmet condition: a conflict with the base, a requirement without a proven change, ' +
      'changed code without tests, findings of the outgoing sieves (a leftover debugger or ' +
      '.only, conflict markers, a committed .env, large files, a manifest without its lock ' +
      'file, destructive migrations, environment variables declared nowhere, removal of files ' +
      'outside the part’s own paths), a refusal of the text sieve, an open question to the ' +
      'human. The core pushes with its own credentials: before the MR it may rewrite the ' +
      'branch with --force-with-lease, after it only adds new commits. The MR goes through the ' +
      'GitLab or GitHub API; another forge gets a push and a link. The core cannot merge or ' +
      'approve an MR: the forge adapter has no such methods. The core waits for CI only if you ' +
      'decided so for this task on the launch screen. Reviewer comments in the MR are handled ' +
      'by the “Reviewer answers” step.',
    cascadeControl: 'Old splits: the summary stays',
    cascadeControlText:
      'A conversation that tasks were split from earlier still shows the group summary under ' +
      'the agent’s answer — from the stored state: a card per group with its branch, the ' +
      'stages passed and the model, and “What the agent got” ' +
      '— the verbatim input of the latest runs (the last 30 per conversation are ' +
      'kept). Children’s questions and permission requests are answered right in the cards. ' +
      'The panel starts no new stage, retry, delivery or branch comparison from such a summary.',
    cascadeRules: 'What a task decides on its own — no group settings',
    cascadeRulesText:
      'The “Itself / With a note / Human” table in “Settings” → “Groups” is gone: the rules of the old ' +
      'panel groups left together with their executor. Whom to call is decided by the core from a ' +
      'closed list of action types, never from the question text. Merging, deleting on the remote ' +
      'or in a foreign copy, writing to a database and changing a service address, credentials, ' +
      'granting access and integrations always wait for a human — the model cannot lift that ' +
      'block. The task’s own delivery — push, MR, replies in discussions — never waits for a ' +
      'human. Everything outside the list is not a question but a fork in the final report: the ' +
      'step carries on with the model’s recommendation. An edit to a path that requires a grant ' +
      'does not pass until the grant is given (section “What moved to the task core” → ' +
      '“Autonomy and permissions”).',
    cascadeEconomy: 'Step economy — the economy section of the core config',
    cascadeEconomyText:
      'The core gives its economy levers to every task step except chat: a ceiling on shell ' +
      'output (8000 characters out of the box), a ceiling on one file read (10 thousand tokens), ' +
      'detaching the session from the IDE and a work-habits line in the brief. The compaction ' +
      'threshold and the cache lifetime are left alone out of the box — the CLI decides them. ' +
      'The levers are changed on the “Task step economy” card in “Settings” → “Groups”: it ' +
      'writes the economy section of the core config, and the next step starts with the new ' +
      'values. A field overrides its default; “CLI default” and a switched-off toggle turn a ' +
      'lever off explicitly; with the core down the card says so. Each CLI carries a lever under ' +
      'its own key and names what it cannot carry as a loss; under every lever the card shows ' +
      'where it works.',
    cascadeWatch: 'Observer — signals in the task feed',
    cascadeWatchText:
      'The panel’s group watch is gone: the core’s observer watches the steps and writes signals ' +
      'into the task feed without calling a model. Every catalogued signal has a severity and an ' +
      'action: “stop” takes the step down, the rest are only shown, and a signal never calls a ' +
      'human by itself. The observer catches an idle or stuck step, wasted work (a failed check or ' +
      'a refusal repeated, a file re-read, an oversized read, a polling loop) and integrity ' +
      '(context growth, a rejected journal write, abandoned processes, the rate window, spend ' +
      'booked to the wrong node). Background work is judged by the system itself, not by journal ' +
      'lines: an orphaned or hung background command and a subagent that outlived its parent are ' +
      'warnings, nothing is taken down. Spend above the estimate is only a note: no pause, no ' +
      'question. The lead’s intake adds its own: a command inside the source text (it is data, ' +
      'not an instruction), a deferred intake card and a wait for a slot for the first session. The ' +
      'watch thresholds card is gone from the settings: the core observer has its own signal ' +
      'catalog.',
    cascadeOverlap: 'Foreign files: ownership instead of branch comparison',
    cascadeOverlapText:
      'The after-work branch comparison and the overlap section are gone. The core checks the ' +
      'parts’ boundaries twice. Before launch the split check keeps two independent parts away ' +
      'from one file. After every step the part’s changed files are compared with its paths: ' +
      'going outside them raises an “ownership” signal in the timeline, and the part’s next ' +
      'brief names those files (up to twenty names, then a count). The core does not roll the ' +
      'edit back and does not stop the step: a neighbouring file is often edited because ' +
      'nothing builds otherwise. Removing a file outside its own paths is blocked by the ' +
      'publish readiness check.',
    cascadePause: 'Stop an old tree at once',
    cascadePauseText:
      'The summary of an old split has a “Stop all (N)” button. It stops every running run of ' +
      'the tree — the parent and all descendants — remembers how to restart each, and takes ' +
      'their auto-approval off. While the tree stands, continuations in a clean session that ' +
      'the panel would start on its own wait in a queue. “Resume all (N)” restarts what was ' +
      'stopped in the same sessions with a note that the turn was interrupted, puts ' +
      'auto-approval back and releases the queue in order. A message you type into a stopped ' +
      'conversation goes out as usual. The pause survives a panel restart. The panel agent can ' +
      'do the same.',
    cascadeLimits: 'What the core never picks by itself',
    cascadeLimitsText:
      'The max effort — never: only your override gives it, and a max picked by the core is ' +
      'replaced by the highest allowed rung, no higher than xhigh. A reviewer weaker than the ' +
      'author: the review’s model and effort are raised to the author’s, and a route that does ' +
      'not allow the author’s model refuses the step with the reason; your override below the ' +
      'author goes through, with a warning. The core never lowers a reviewer at all. A route ' +
      'outside the task’s allowed set never reaches a step, even if the scenario names it.',
    cascadeForeign: 'Other CLIs',
    cascadeForeignText:
      'The same rules hold for any CLI the core runs a step with. The core can lower the model ' +
      'and raise the effort only where its adapter has a model ladder — Claude and Qwen Code. ' +
      'Other CLIs run on the chosen model or the CLI’s default. A new conversation with ' +
      'another CLI starts in this same chat while its provider is active (see “What moved to ' +
      'the task core” above).',
    cascadeNote:
      'Old conversations with split stages — “triage”, “plan”, “review”, “fixes”, “delivery” — ' +
      'open and are labelled in the chat list as before, but the panel starts no stage on its ' +
      'own any more.',

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
      'job along with the checkpoint — in full; a task longer than 200,000 characters is ' +
      'cut with a visible label, never silently — so the third session in a row still knows ' +
      'the bounds of its work. A conversation continues at most eight times in a ' +
      'row (review and fix stages do not count), and if the checkpoint is word for ' +
      'word the same as at the previous move — or as when this work was carried to ' +
      'another CLI on the "Environment passport" page, the memory here is one — the ' +
      'panel stops earlier: the agent is going in circles. A move that did not ' +
      'happen is explained by a toast: the ' +
      'run failed, the checkpoint was not updated or did not change, the chain ran ' +
      'out. Turn it off per conversation with the toggle, or everywhere in Settings ' +
      '→ “Continue on its own in every conversation”; one switched off by hand ' +
      'stays off. Neither of them waives the safeguards. ' +
      'Work the agent itself marked closed and verified (“nothing to continue”) is not ' +
      'continued by the panel at all: a new session ' +
      'would only read the checkpoint file and say everything is done. The card stays, ' +
      'and the button still continues it. If a Stop hook returned a remark to the agent ' +
      'after its summary, the panel judges the summary together with the reply to the ' +
      'remark, not the reply alone.',
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

    coreMovedTitle: 'What moved to the task core',
    coreMovedCaption:
      'Splitting, group trees, autonomy and the chat of other CLIs no longer live in the panel chat: the ' +
      'task core runs them. Here: where each one is now and what the core does not have.',
    coreMovedSplit: '«Split» and group trees',
    coreMovedSplitText:
      'The «Split tasks» button and the buttons on the proposal card are gone from the chat; the chat starts ' +
      'no new trees or parent summaries, and old splits keep their summary read-only (section below). ' +
      'Work in parts is a core task: the «Core tasks» section, launch with an estimate, a task feed with ' +
      'the «why». Answers to MR comments, part boundaries and the tracker status are steps and checks of ' +
      'the core scenario, not chat buttons.',
    coreMovedAutonomy: 'Autonomy and permissions',
    coreMovedAutonomyText:
      'The chat menu has no «Autonomous — pick the recommended» item. The chat runs right in the project ' +
      'folder, and starting the chat is your edit grant for that root; outside it the core refuses. The core ' +
      'writes a permission question to the task journal, the panel shows a card; the «Permissions» toggle ' +
      'in the chat menu, when on, removes such questions with an edit grant the window gives the core itself.',
    coreMovedWatch: 'Group watcher and verify ledger',
    coreMovedWatchText:
      'Group signals and narrowing of repeated runs are done by the core: the observer writes signals to the ' +
      'task feed, the verifier decides which checks to repeat. The chat card no longer shows them.',
    coreMovedContinue: 'Continuing after a long pause',
    coreMovedContinueText:
      'A new conversation with a brief after a long pause and the «warm cache» ping left the chat. Whether ' +
      'to continue the session or start a new one with a brief is decided by the core from the cache age.',
    coreMovedForeign: 'Chat of other CLIs',
    coreMovedForeignText:
      'A new conversation with Codex, Qwen Code, OpenCode and other CLIs starts in the same chat as with ' +
      'Claude: the New chat button while that CLI’s provider is active. There is no separate screen, ' +
      'Projects tab or «New conversation here» button any more; old core chat addresses lead to this chat. ' +
      'A clean-session continuation and carrying unfinished work to such a CLI land the same way: a new ' +
      'conversation in the chat list (and on the phone) that survives a page reload and, reopened from the ' +
      'list, continues the same session. The feed of a continuation or a carry shows the task only, not ' +
      'the panel’s service instructions to the model. The core does not continue a conversation whose ' +
      'history the earlier panel held: it continues only a conversation whose transcript the CLI itself ' +
      'confirmed.',
    coreMovedRefused: 'What the core does not have for the chat',
    coreMovedRefusedText:
      'Three turns are refused by name instead of being lost silently: editing a sent message with a fork ' +
      '(the claude adapter has no --fork-session), the one-off warm cache ping, and a turn the CLI started ' +
      'itself, since the core session host holds the CLI, not the panel.',
    coreMovedNote:
      'The old routes for sending to another CLI conversation answer with a refusal and its reason: an ' +
      'old phone build shows the explanation, not an empty screen.',

    deferredTitle: 'Awaiting decision: former D-n calls',
    deferredCaption:
      'The D-n list is left over from the panel before the core: back then an agent set a ' +
      'call only a human decides aside under a number D-n and kept working. No new items ' +
      'appear any more. Old ones stay visible until they expire, and a decision on them is ' +
      'only recorded — it does not resume any work.',
    deferredWhen: 'Where new questions went',
    deferredWhenText:
      'A chat turn runs as a core task, and its permission question is not set aside: the ' +
      '«Core question» card stays in the chat window and the step waits for the answer (above, ' +
      'and the «Permissions» document). Telegram only reports such a question. The agent does ' +
      'not push, open MRs or write to the forge itself: only the core publishes, and it ' +
      'refuses such an agent command.',
    deferredList: 'Where you see them',
    deferredListText:
      'While old items exist, every panel page has an “Awaiting decision (N)” plate with a ' +
      'hint and a “Show” button: the list of waiting items, filterable by group or chat — the ' +
      'number, project, group or chat, the reason (“The group’s permission rows send this ' +
      'call to a human”, “The call is not covered by the auto-approve rules”, “An edit in the ' +
      'main copy of the project: you decide where it writes”, “Backend guard: …”), the ' +
      'command itself and the time. On the phone waiting items come first in “Questions”, ' +
      'and with Telegram answers on an item reaches Telegram too (the “Integrations” document).',
    deferredDecide: 'The decision',
    deferredDecideText:
      '“Allow” and “Deny” record the decision in the item — and nothing more: the conversation ' +
      'the call came from is not resumed and nothing reaches the agent — the panel no longer ' +
      'runs the session that waited for the answer. If the work is still needed, open the ' +
      'conversation with “Open chat” and ask in words; the turn runs as a core task. Only a ' +
      'human answers: an agent call that reaches the panel’s decision endpoints, the phone ' +
      'signing mode or its key is refused before every rule. With “decisions only with the phone’s signature” on (the ' +
      '“Phone” document), “Allow” is accepted only from a paired phone, while “Deny” ' +
      'works from anywhere.',
    deferredLimits: 'Lifetime and limits',
    deferredLimitsText:
      'An item waits «Days a D-n ask waits for an answer» (7 by default, up to ' +
      '90), then expires. Decided items stay visible for a day. The list lives in the panel’s ' +
      'data directory and survives a panel restart; an item left by an earlier panel version ' +
      'is decided the same way — the decision is recorded and starts nothing.',
    deferredNote:
      'A D-n is neither a default permission nor a work queue: neither “Allow” nor “Deny” runs ' +
      'anything.',

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
      'thinking” or “the agent is busy — it reads the answer at its next step”, and ' +
      'once the answer has arrived and the agent carries on, a tick and “Answer ' +
      'received”. The ' +
      'note appears on the click, not on the server reply: the agent answers in tens ' +
      'of seconds, and all that time it must be obvious the click went through. An ' +
      'answered question stays answered: switching tabs and reloading the page do ' +
      'not revive it, and it cannot be answered twice — that would be a second turn.',
    askBusy: 'The agent is busy — you can still answer',
    askBusyText:
      'The question arrives MID-turn: the agent asks it and goes right back to ' +
      'writing code. That is why the options are not dimmed while a run is going — ' +
      'the choice is needed exactly now. An answer to a busy agent goes to it at ' +
      'once: the agent reads it after the current step and carries on with the same ' +
      'turn. Where that is impossible (a CLI with no mid-answer input) the answer ' +
      'queues up and goes out when the turn ends.',
    lostTitle: 'The connection to a run can be lost — and you will be told',
    lostText:
      'The event stream lives in the browser while the agent lives on the server, so ' +
      'a sleeping machine or a blinking network breaks the view, not the work. Half ' +
      'a minute of silence and the feed says “connection lost, reconnecting”; the ' +
      'half-written bubble goes dark on purpose — it is cut mid-sentence, while the ' +
      'full answer is being written to the transcript the feed reads from. If the ' +
      'reconnects do not help, instead of silence you get “show from the history” — ' +
      'reread the conversation, where the answer already is.',
    failTitle: 'A turn failed — the card says why and what to do',
    failText:
      'Under the error text sit “Retry” (the task again) and “Continue” (finish from ' +
      'where it broke off). A failure of the CLI itself, with no model answer, shows ' +
      'its reason rather than a bare “Request failed”. Two errors the panel explains ' +
      'in words. An outdated CLI: the card names the version the panel runs and the ' +
      'one the model needs, shows the CLI path, a newer copy if there is one further ' +
      'down PATH, and an “Update CLI” button. An overflowing context: the same ' +
      'conversation will accept neither a retry nor a continuation, so in their place ' +
      'come “Compact context” and “Continue in a new session”; for a split parent the ' +
      'groups move to the new conversation with it.',
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
      'Next to the task sits a model + effort pair with no rung above the model of ' +
      'the conversation itself. It defaults to that pair, ' +
      'and lowering it is a deliberate act: five agents starting at once at the ' +
      'ceiling eat the rate window faster than anything else the panel does, while ' +
      'fan-out work is usually the same and well understood. One rung covers the ' +
      'whole launch — different models per project would give different results for ' +
      'one and the same task. A rung like “Sonnet” is expanded by the panel into the newest ' +
      'model of that family in the catalog: at the CLI such an alias leads to the recommended ' +
      'model, not the latest one. Lowering is paid for with a delivery bar: the task ' +
      'gains the duty to run the project checks, verify the result point by point ' +
      'and stop when the work turns out to be of another class. No review at the ' +
      'ceiling is started here — review and delivery steps exist only for core ' +
      'tasks, the fan-out starts plain conversations, and promising review to it ' +
      'would be a lie.',
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
      'started from. No separate project tabs ' +
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
      'The paperclip, a drag onto the field or a paste from the clipboard (Ctrl+V): ' +
      'a screenshot without a name becomes a pasted-<date>-<time>.png chip, and ' +
      'clipboard text is pasted as usual. Up to 20 MB per file; images, PDF, ' +
      'markdown, text, tables, code. The file is stored in a panel folder, and ' +
      'the turn carries it to the task core: the core puts a copy into the task ' +
      'attachments folder, Claude gets the path of that copy and reads it from disk itself — ' +
      'the core session does not read the panel folder. An unsuitable file is ' +
      'refused right away, at attach time, and never becomes a chip: a type the ' +
      'panel does not pass (an .exe, say) gets a message listing the allowed ' +
      'extensions; a file over the limit gets a message with its size next to the ' +
      'limit, “big.pdf — 25 MB”.',
    composerChips: 'Quick action chips',
    composerChipsText:
      'In an empty chat — ready-made openings: in a project that means review, ' +
      'bug hunting, a structure walkthrough, tests. A chip fills the field but does ' +
      'not send: you can add to it first. Next to them sits a separate “Open in ' +
      'editor” chip — not about the conversation, it just opens the project.',
    composerStop: 'Stop',
    composerStopText:
      'While an answer is streaming, “Stop” sits next to send: it cancels the core task ' +
      'running the turn, and the next message starts a new one that continues the ' +
      'conversation. Sending is not locked meanwhile: a message written during the answer ' +
      'is handed by the core to the same step at the nearest turn boundary — the same for ' +
      'Claude and for Codex, Qwen, Goose, Kimi Code and OpenCode. “Stop” stays until the turn ' +
      'has answered the added message too: the reply to it comes in the same turn. Old conversations of other ' +
      'CLIs, open read-only, have neither sending nor a queue.',

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
    editsForeignTitle: 'Edits in another CLI’s chat',
    editsForeignText:
      'A new conversation with Codex, Qwen Code, Goose, Kimi Code or OpenCode runs as a core ' +
      'task in the same chat, and its header has no edits switch. A launch from ' +
      'the chat is itself the right to edit inside the project folder: there the CLI writes ' +
      'without asking. A request outside it arrives as a core question card: grant the right ' +
      '(project, paths, actions) or refuse; the card lives in the task journal and survives ' +
      'leaving the page and F5. A CLI the core has no adapter for gets the core’s refusal ' +
      'with its code as a line in the feed — there is no silent fallback to the old runner.',

    autoApproveTitle: 'Auto-approving permissions',
    autoApproveText:
      'The «Auto-approve permissions» toggle («Permissions auto» / «Permissions manual») ' +
      'lives in the «Chat settings» menu on the right of the header, and it is ON by ' +
      'default. A chat turn runs as a core task, and the core judges the step’s permissions: ' +
      'whatever it does not forbid goes through with no card — exactly as it would outside ' +
      'AgentDeck. The core forbids publishing by the agent (push, MRs, forge writes — only the ' +
      'core publishes), the writing tools of your GitLab or GitHub MCP server, and an edit of ' +
      'a path the task needs a grant for. The last one is the only question to a human, the ' +
      '«Core question» card. The toggle on is an edit grant on the task’s whole repository, ' +
      'which the window hands the core with its own command: no such questions, between turns ' +
      'too. Off — every such path asks with a card, and Allow grants that path. The answer ' +
      'goes to the core from the window itself or from a phone with a bound key: the panel ' +
      'server may not answer for you. The toggle position is remembered per chat.',

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

    trailTitle: 'Turn trail',
    trailCaption:
      'Each agent turn ends with one collapsed line: “1 skill · 2 agents · 3 scripts · ' +
      'hooks 26, 2 of them added context · 1.4 s”. A click or Enter expands it; a turn ' +
      'with nothing to show gets no line.',
    trailRun: 'Skills, agents, scripts',
    trailRunText:
      'What the agent ran: skills by name, agents with the task description and model, ' +
      'scripts with the call description. A script is a file run (node, python, bash and ' +
      'others with a path, ./x.sh) or a package script (pnpm, npm, yarn, make); plain ' +
      'commands such as git, grep or ls and MCP calls are not part of the trail. Shown ' +
      'right away, while the turn is running.',
    trailHooks: 'Hooks',
    trailHooksText:
      'Hooks by event (PostToolUse:Bash, Stop…) with the command name, a ×N count and ' +
      'the time; a failure carries a red mark with the exit code. “Added context” expands ' +
      'the start of the text the hook gave the model, with secrets masked. Hooks come ' +
      'from the Claude Code transcript and appear once the turn is over; a hook that ran ' +
      'silently is not recorded by the CLI. A message added mid-turn and a background-task ' +
      'notification do not split the turn.',

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
      'each subscription window is used is shown by the «Plan usage limits» block at the ' +
      'top of the sidebar.',
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
      'without a timestamp get no column. An answer from a local model (not cloud ' +
      'Claude) also shows its speed on the badge — “N tok/s”: generated tokens over ' +
      'generation time, prompt reading excluded. It stays after the turn ends and ' +
      'after a reload; an answer written outside the panel (in a terminal) has none — ' +
      'only the panel’s live stream knows the generation time. Such a model has no ' +
      'price until you set one yourself in the pricing settings. While a turn on a ' +
      'local model runs, a server line sits under the messages: model, quantization, ' +
      'window and stage — loading, reading the prompt (how many tokens of how many, ' +
      'with a bar), answering, waiting for your permission, “the agent is preparing a ' +
      'request to the model” (the turn has begun, no request yet), or “the agent is ' +
      'running tools”. If the server stays silent for over 20 seconds, the line says how ' +
      'long until the request is retried and offers a “Restart the server” button. If ' +
      'the model server refuses a request, the line turns red and quotes its code and ' +
      'text: the turn is stuck not on tools but on a server that will not take the ' +
      'request; a successful answer clears that line.',

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
    noteCleanupTitle: 'Claude Code deletes old conversations itself — after 30 days by default',
    noteCleanupText:
      'The period is the cleanupPeriodDays setting in settings.json, counted from the last ' +
      'write to the conversation file, not from its groups’ work: the main chat of a split ' +
      'that nobody wrote to lately is erased even if its groups ran yesterday. Deleted means ' +
      'gone — to keep history longer, raise that key in settings.json. If the main chat is ' +
      'already erased, its groups are not scattered across dates: they sit under ' +
      '“Parent chat deleted”.',
    noteRestartTitle: 'A panel server restart does not kill the agent — the run is picked up',
    noteRestartText:
      'The CLI process is held not by the panel server but by a separate relay, so a ' +
      'server restart does not touch it. Running runs are recorded in a ledger on disk ' +
      '(runs.json in the panel data folder) together with the relay’s address, and on ' +
      'start the server connects to it again: it receives the output gathered without ' +
      'it and carries the session on as its own — the stream in the feed, permission ' +
      'cards, Stop, waking up after background commands. A run without a relay is ' +
      'picked up by its process being alive, but without an output stream: the answer ' +
      'is read from the conversation, and the feed says so in a line. A process that ' +
      'left mid-turn taking background commands with it counts as cut off, not ' +
      'finished: its answer does not know the results of that background work. When ' +
      'the run ends the panel ' +
      "reads the agent's last completed turn out of the conversation — both a clean " +
      'session continuation and the work → review → fix pipeline follow from it; a turn ' +
      'cut short on a tool call does not count as a closing one, and then there is ' +
      'nothing to decide by. A run missing from the ledger is looked up there once more ' +
      'right on the permission request, and only then refused — "the panel restarted, ' +
      'send the message again" — the same text showing in the conversation as the call ' +
      'result. A permission request made while the server is down waits for it to ' +
      'come back as long as a card waits for a human decision — ' +
      'instead of refusing on the human’s behalf. Allow pressed in the first seconds ' +
      'after a restart, before the request reached the new server, is not lost: the ' +
      'answer waits for the request to be repeated and goes to the agent with it. ' +
      'Under "pnpm dev" the server watcher ' +
      'tries the new build before restarting: an edit the server would not start with ' +
      'leaves the previous server running, and the file and error line go to the ' +
      'watcher log; a server that crashed on its own is started again. Only the panel ' +
      'server can connect to a relay — the channel is locked with a key from the run ' +
      'ledger. If the relay was ended from outside, the feed says "The chat process was ' +
      'lost": the conversation is intact, and the next message continues it in the ' +
      'same session.',
    noteLiveTitle: 'A conversation running outside the panel is picked up on its own',
    noteLiveText:
      'The same chat can be driven from a terminal or an editor extension — such a ' +
      'turn has no event stream of its own. The feed still updates: the server ' +
      'watches transcript files and reports changes, and the panel additionally asks ' +
      'for the fingerprint of the open conversation every few seconds — in case file ' +
      'watching is switched off in settings or the stream broke. No page reload needed.',
    noteProviderTitle: 'Other providers: the same chat',
    noteProviderText:
      'With a non-Claude provider active, the Chat section is the same: project tabs, the chat ' +
      'list and the New chat button, which starts a conversation on that provider’s CLI. A ' +
      'conversation already started keeps its CLI after the provider is switched back. A new ' +
      'conversation runs the same way as with Claude: as a core task, with the panel layer and ' +
      'the contour route (step “Open the project and start a conversation” above). What a CLI ' +
      'can do in a core turn is up to its adapter; a CLI the core refuses gets a refusal line ' +
      'with a code in the feed (section “Edits in another CLI’s chat”).',
  },
  shots: {
    basics: {
      '01-project-empty':
        'A new chat right in the project tab: the first message creates a core task on the active provider’s CLI',
      '02-composer': 'A question with a file attached — the attachment shows as a chip',
      '03-answer': 'The answer as it is generated: thinking, tool calls, spend, text',
      '04-permission': 'The agent stands on a call and waits for a decision: deny or allow',
      '05-question': 'The agent asks: three questions in a row, the next opens after an answer',
      '06-branch': 'The git strip expanded: changed files, pull and push, branches and copies',
      '07-menu': 'The conversation menu: permission toggles and actions on the conversation',
      '09-agents': 'The agents panel: who is running, whose spend, and one stop button',
      '10-handoff': 'A stage is closed: an offer to continue in a clean session from a file',
    },
    agents: {
      '01-tree':
        'The agent’s plan: steps, the subagent tree and the “Agents” card with the background count',
      '02-history':
        'The “Agents” window: core nodes of every task of the chat, the selected subagent’s spend and refusals',
      '03-background':
        'A background command in detail: output, whose it is and how it ended — “orphaned — reaped by cleanup”',
    },
    economy: {
      '01-where':
        'Settings → Groups, the “New conversation after a long pause” lever: the “Where it ' +
        'works:” line — own setting, by the panel, with a condition, and the muted “not ' +
        'needed” and “not worth it”',
    },
    deferred: {
      '01-banner':
        'The “Awaiting decision (3)” strip expanded: D-n items of two groups and a single ' +
        'chat, the owner filter, and the reason and answers on each',
    },
  },
  diagrams: {
    'message-path':
      'The path of one message: composer to panel server to CLI process to the transcript on disk, and the answer back as a stream. The panel has no database of its own.',
    'deferred-asks':
      'The former path of a call only a human decides (before the core): a refusal with a D-n number, work goes on, an answer from the panel, the phone or Telegram. Now the answer is only recorded and does not resume the work.',
  },
};
