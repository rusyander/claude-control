import type { localModelsRu } from '../../ru/topics/localModels';

/** Typed against the Russian topic: a key cannot be forgotten in translation. */
export const localModelsEn: typeof localModelsRu = {
  topic: {
    title: 'Local models',
    summary:
      'A coding model on your own graphics card: pick, download in one click, measure and hand to agents',
    lead:
      'This section puts a coding model on your machine and hands it to the panel’s agents. It ' +
      'reads the graphics card itself, shows which models will run on it and how fast, downloads ' +
      'the model server (llama.cpp) and the model, starts the server with the right context and sets up the ' +
      'local-model contour — everything that used to be installed and configured by hand. Models ' +
      'already downloaded in Ollama are taken over without downloading again. The ' +
      'cloud comes back in one click.',

    guideTitle: 'What this document covers',
    guideText:
      'The section is split into three tabs in the order of the path: “Hardware & server”, ' +
      '“Models”, “For agents”. First a diagram of where an agent’s request goes. Then the section frame by frame, from ' +
      'the first visit to agents on your own card. After that: what the catalog marks mean, ' +
      'whose kit the agent gets, where the files live and what a local model cannot do.',

    whyFit: 'For your card, not in general',
    whyFitText:
      'Every catalog model is marked for THIS machine: whether it fits in video memory, with what ' +
      'context and how many tokens per second it gives. The estimate comes from the card’s memory ' +
      'bandwidth; “Measure” measures the real speed.',
    whyOne: 'One button instead of a manual',
    whyOneText:
      'Model server, its launch arguments, context, the address for Claude Code — the panel does ' +
      'it all. The work runs on the panel’s server: closing the tab does not stop a download, and ' +
      'an interrupted download resumes where it stopped.',
    whyBack: 'There and back in one click',
    whyBackText:
      'The chat header has a “Local” button next to the model choice. A click turns on the ' +
      'model chosen for agents with its settings (quantization, window, cache): chats move to ' +
      'it at once while the model loads into video memory in the background — the button says ' +
      '“loading” and the first message waits for it. Turned on, the button is highlighted and ' +
      'names the model; a second click returns the cloud and frees the video memory. When there ' +
      'is nothing to turn on (no model server, no model, or no model chosen for agents), every ' +
      'click explains what is missing and leads to the right tab; a downloaded model can be ' +
      'turned on right there. ' +
      'Agents are switched through the contour, per run: the contour writes nothing to ' +
      '~/.claude, and “Back to the cloud” restores everything as it was. Only the “Claude Code ' +
      'on this model” checkbox writes there, and only if you turn it on.',

    mapTitle: 'Where an agent’s request goes',
    mapCaption:
      'Left: what the human does; middle: the request’s path; right: where the model lives and what it cannot do.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A chat, group or test starts Claude Code as usual. The panel gives it the address of its ' +
      'gateway; through the local-model contour the gateway passes the request to the model ' +
      'server (llama-server) on 127.0.0.1:11435, which holds the model in video memory. The contour’s mode is ' +
      '“required”: if the server does not answer, the request does not silently go to the cloud — ' +
      'it fails with a clear error. The panel’s own helpers — the panel agent, the form helper, ' +
      'the assistant window, the watcher and group service calls — take the same contour: ' +
      'connecting makes it the “Panel assistant”, and “Back to the cloud” restores the previous ' +
      'choice. If the gateway did not start (port busy), the section shows a red check with the reason.',

    guide: {
      firstTitle: 'Frame by frame: the section itself',
      firstCaption:
        'From the first visit to agents on your card. There are three buttons: “Download” for the ' +
        'server, “Download” for the model and “Hand to agents”; “Download and connect” in the line ' +
        'above the tabs does all three in a row — on a clean machine it installs the server too.',
      firstMachine: 'First visit: card detected, no server yet',
      firstMachineText:
        'The “Hardware & server” tab. On the left is your machine: the card, its video memory and how much is free, bandwidth, ' +
        'RAM and disk space. On the right is the model server: “Download” puts llama.cpp into the panel folder — ' +
        'the build is pinned in the panel and the panel checks its checksum itself. Ollama is not started and not needed.',
      firstCatalog: 'The catalog for this card',
      firstCatalogText:
        'The “Models” tab. Each model shows how it was trained (for code, tuned for code or general), whether it ' +
        'fits, its context, how much memory it needs and the speed estimate. “Recommended” is the ' +
        'best one for an agent on this machine. A red line under a model says why it will not do ' +
        'for an agent. The order runs from the best choice: “Recommended” on top, then the models that fit ' +
        'entirely, then “partly in system memory”, and the ones that do not fit at the bottom.',
      firstPulling: 'Downloading',
      firstPullingText:
        'A bar, the speed and the time left. “Cancel” stops the download but keeps what was ' +
        'fetched: the next click resumes where it stopped.',
      firstReady: 'The model is ready',
      firstReadyText:
        'On the “Hardware & server” tab the server is running and holds the model in memory — you ' +
        'can see how much video memory it takes. “Where to compute” is the video card or the ' +
        'processor, and the “In memory” line tells where the model actually went. On the “Models” ' +
        'tab the model has “Measure” — it measures the real speed and shows it next to the ' +
        'estimate — and the “Used by agents” mark: this model is answering chats right now.',
      firstAgents: 'Agents and the kit',
      firstAgentsText:
        'The “For agents” tab: which model the agents use now, and the “Back to the cloud” button. The “Claude Code on ' +
        'this model” checkbox (off) sends Claude Code itself there too. Below are Qwen Code ' +
        'and the kit choice: whose skills, hooks and rules the agent gets while it runs on the ' +
        'local model.',
      choiceTitle: 'Frame by frame: quantization and context',
      choiceCaption:
        'The card of every model, catalog, downloaded or your own, has two blocks: “On this machine” on the left (speed, memory, file, measurement) and “Launch settings” with the two lists on the right. The choice is remembered for ' +
        'that model and applies to every launch: “Hand to agents”, “Measure”, a server restart. Nothing chosen means the card-based pick.',
      choiceSelects: 'Two lists on every model',
      choiceSelectsText:
        'Quantization is the repository’s files with their sizes; “downloaded” marks a file already on disk. Context ' +
        'runs from 8K up to the model’s limit; by default it is what the catalog considers sensible for the model ' +
        '(128K for Qwen3.6 27B Coding and Qwen3.8 27B) if it fits. Each list closes the options that would not fit together with the ' +
        'choice in the other one and says why in numbers: “does not fit: needs 26.1\u00a0GB of 24”. A context under 32K is ' +
        'closed for agents: Claude Code’s system prompt alone takes about 20 thousand tokens. The fit is computed from ' +
        'the video memory available to the model right now, and the line above the list says which figure; the row ' +
        'restates the same for the selected pair: what it needs, the speed, the cache. Under the lists sits the ' +
        'recommendation for this machine: the default window and the best quantization (up to Q6_K) that fits ' +
        'it entirely in the available memory; if nothing fits, the window steps down, never under 32K. It is ' +
        'computed from the memory size alone, never from the vendor. When another pair is selected, “Apply” sets the recommended one. A quantization below Q4 is ' +
        'marked “low quality”. A file imported from Ollama shows the real quantization read from the GGUF header ' +
        'and the note “imported from Ollama”; when it cannot be read, “unknown quantization”.',
      choiceOther: 'A quantization that is not on disk',
      choiceOtherText:
        'The row is recomputed for the choice: size, memory needed, speed. The “Download” button carries the file name ' +
        'and size. While the file is missing, “Hand to agents” and “Measure” are hidden: a launch would go to a file ' +
        'that is not there. A measurement taken at another context or quantization is marked stale, since the speed differs.',
      choiceRestart: 'Changing it on a loaded model',
      choiceRestartText:
        'If the server holds this model, the choice differs from what it runs and the file is already on disk, the ' +
        'server restarts with the new settings; the row shows “Restarting with the new settings…”. A quantization ' +
        'that is not downloaded leaves the server alone: the choice is remembered and the button offers the download.',
      choicePartialTitle: 'Partly in system memory, only by permission',
      choicePartialText:
        'An option that does not fit the video memory entirely but fits with some layers offloaded to system memory ' +
        'stays closed until the model’s “Partly in system memory” switch is on. The speed drops several ' +
        'times — fine for questions, not for an agent. A choice that does not fit at all is refused by the server, ' +
        'and the answer says how much is needed and how much there is.',
      customForm: 'Any model: a repository or a link',
      customFormText:
        'Below the catalog sits the “Repository or link” field: owner/repository or a Hugging Face address. The panel ' +
        'reads the repository’s quantization list and the model layout from the GGUF header (only the start of the ' +
        'file is fetched), downloading nothing whole. No GGUF, or an architecture the server does not know, is refused ' +
        'with the repository name.',
      customRow: 'Your own model in the list',
      customRowText:
        'The row carries a “Custom” mark and the same two lists. “Tool calling not verified” stays until the panel ' +
        'checks with one request whether the model calls tools, which happens at “Hand to agents”; until then the model ' +
        'counts as an agent “with a caveat”. Passed: the mark goes away. Failed: “Does not call tools”, and the model ' +
        'no longer counts as an agent. The trash button removes the entry and deletes the model files.',
      filesRow: 'On disk: downloaded quantizations one by one',
      filesRowText:
        'Under the model row sits “On disk”: every downloaded quantization with its size and its own trash button; the ' +
        'button label says how much space comes back. The quantization currently loaded into the model server has no ' +
        'trash button — instead it reads “loaded into the server — stop the server to delete it”, and the whole-model ' +
        'trash button in the row header is closed too. A file brought over from Ollama is marked “link to the Ollama ' +
        'file”: it is the same entry on disk as Ollama’s, so deleting it frees 0 GB and the model in Ollama stays whole.',
      filesConfirm: 'Deletion — after confirmation',
      filesConfirmText:
        'The trash button opens a dialog naming the quantization and the space that will be freed; nothing is deleted ' +
        'until “Delete”. The unfinished download next to the file goes with it. If the chosen quantization was deleted, ' +
        'the choice moves to another one still on disk. The panel refuses rather than stopping the server itself when ' +
        'the server holds the file, a download into it is running, or a running local run would restart the server on ' +
        'exactly that file: the answer says what to do first.',
    },

    fitTitle: 'Catalog marks',
    fitCaption: 'What each coloured mark next to a model means.',
    fitHeader: 'Mark',
    fitWhat: 'Meaning',
    fitGpu: 'Fits the GPU',
    fitGpuText:
      'Weights and context are entirely in video memory. This is the only mode in which an agent ' +
      'works at a normal speed.',
    fitPartial: 'Partly in system memory',
    fitPartialText:
      'Some layers go to system memory. The model works, but several times slower — fine for ' +
      'questions, not for an agent.',
    fitNone: 'Does not fit',
    fitNoneText:
      'Neither video memory nor RAM is enough: the model will not start on this machine.',
    fitNoTools: 'Not an agent',
    fitNoToolsText:
      'The model does not call tools: it cannot read files or run commands. Fine for questions ' +
      'and completion, not for an agent.',
    fitSmall: 'Short context',
    fitSmallText:
      'Fits only with a context smaller than an agent needs: the system prompt and the files it ' +
      'reads will not fit.',
    fitCpu: 'On the processor',
    fitCpuText:
      'Computing on the processor is selected: the model sits fully in RAM, the card takes no ' +
      'part. It works, but tens of times slower than the card: Qwen3.6 27B on a Ryzen 9 7950X ' +
      'gives 4 to 9 tokens per second against 107 on an RTX 4090. Fine for questions; an agent needs 8 or more.',

    deviceTitle: 'Where to compute: video card or processor',
    deviceCaption:
      'The switch is in the model server card, “Hardware & server” tab. The video card by default.',
    deviceGpu: 'Video card',
    deviceGpuText:
      'Tens of times faster than the processor. The catalog is marked by the card video memory, ' +
      'and the memory a loaded model already holds is credited to it — the marks do not turn red ' +
      'just because the model is running.',
    deviceCpu: 'Processor',
    deviceCpuText:
      'When the card is busy with something else (a game, a render) or the model does not fit. ' +
      'The model server starts with the video cards hidden, the model goes fully into RAM, and ' +
      'the catalog is marked by RAM.',
    deviceRestart: 'Switching restarts the server',
    deviceRestartText:
      'The device is set when the server starts: switching restarts it and unloads the model. ' +
      'The “In memory” line shows where the model actually went — from the server answer, not ' +
      'from the choice: fully on the card, on the processor, or a share on the card.',
    memoryTitle: 'Memory, idle and the prompt cache',
    memoryCaption:
      'What the server does while you are not typing, and how it avoids recomputing the same prompt. The “Keep the model loaded” switch is in the server card, “Hardware & server” tab.',
    memoryIdle: 'Unloading on idle',
    memoryIdleText:
      'After five minutes without requests the server unloads the model from memory; the period is ' +
      'chosen in the server card — “Unload after idle”: 5 minutes, 15 minutes or 1 hour. If the ' +
      'conversation cache is written to disk before that (with Claude Code it is almost always over ' +
      'the threshold), the server counts the write as work and restarts the idle count — then the ' +
      'model leaves almost twice as late: around the ninth minute at five minutes, about two hours at ' +
      'one hour. A long period keeps video memory taken, while coming back after an unload costs ' +
      'seconds: the model loads and the conversation cache is read back from disk. Measured on ' +
      '14 Oct, video memory fell from 7090 to 1842 MiB and RAM from 4662 to 392 MiB. The first ' +
      'request after idle loads the model again — about four seconds on a 7B, longer on bigger ' +
      'ones. The “In memory” line is empty meanwhile and the card says the model is unloaded by ' +
      'idle. “Keep the model loaded” turns unloading off; the server restarts at once, or after the run if one is going.',
    memoryCache: 'Prompt cache',
    memoryCacheText:
      'The agent system prompt and history are not recomputed every turn: the server keeps a ' +
      'prompt cache in RAM — a quarter of the free memory, 1 to 8 GiB — and state checkpoints. ' +
      'Cache shifting (`--cache-reuse`) is enabled only where the server supports it: hybrid ' +
      'models with a recurrent state, such as Qwen3.5/3.6, do not support it, so it is not set — ' +
      'the server would silently turn it off anyway.',
    memoryChats: 'Switching the conversation: the cache goes to disk',
    memoryChatsText:
      'When a request comes from a different conversation, the previous one’s cache is written to ' +
      'disk (the run/slots folder) and the new one’s cache is loaded from its file. No file — the ' +
      'slot is erased: a new chat does not inherit someone else’s prefix. Measured 15.10 on Qwen3.8 ' +
      '27B: going back to a 22-thousand-token conversation recomputed 41 tokens instead of 22 ' +
      'thousand, and the turn took 8 seconds instead of 20. A cache shorter than 8192 tokens is not ' +
      'written: such a prompt is faster to read again. 45 seconds before the idle unload the cache ' +
      'also goes to disk, so the first turn after sleep does not read the prompt from scratch. A ' +
      'file weighs about 100 KB per token. At most six files and 32 GB are kept, the oldest go ' +
      'first; files taken from another model, window, cache or template are deleted. A sleeping ' +
      'server is not woken for the erase. Cleanup runs after every write, at panel start and once an ' +
      'hour: files older than three days and files without a description (a write cut off midway) ' +
      'go. The cache of a chat that ended with an error stays until then — coming back to that chat, ' +
      'you do not wait for a re-read.',
    longTitle: 'Overnight run: what keeps the task alive',
    longCaption:
      'A local model is left alone overnight: what the panel relies on so that the run either finishes or stops only where a human is needed.',
    longSupervisor: 'The model server is supervised',
    longSupervisorText:
      'Every fifteen seconds the panel checks the model server. If it died or hung (eight ' +
      'checks in a row without an answer) it is started again with the same settings; the ' +
      'request that found it unreachable is sent a second time after the restart. At most ' +
      'three restarts in ten minutes; if the server still will not come up the panel does not ' +
      'give up but tries less often — once every ten minutes — and the server card keeps a ' +
      'message with the attempt count, the last reason and the time of the next try; a ' +
      'successful start resets the count. You can start the server by hand at any moment. A ' +
      'server stopped with the button is not restarted, neither by the timer nor by a run’s ' +
      'request. The timer only restarts a server that already answered in this panel run; a ' +
      'run’s request that finds the server down starts it even after a computer reboot, from ' +
      'the remembered launch, but no more than three failed starts in a row (see «Context is ' +
      'server-wide»). While the server is down and a run is going, the model gets ' +
      '“server unavailable” and the client waits without limit (by design: a night must not ' +
      'cut the task): you see it on the server card, and the wait is ended with the stop ' +
      'button in the chat.',
    longAwake: 'The computer does not fall asleep',
    longAwakeText:
      'While a run on a local model is going, the panel asks the system not to sleep (Windows, ' +
      'macOS and Linux with systemd). The switch is in the server card, “Hardware & server” ' +
      'tab, on by default. The screen may turn off; with no runs the block is released by ' +
      'itself. With the switch off, sleep in the middle of a run ends it. The block does not ' +
      'hold a closed laptop lid or “modern standby”: for an overnight run keep the laptop ' +
      'open and plugged in. A run picked up after a panel restart holds the block too.',
    longDefer: 'A restart waits for the end of the run',
    longDeferText:
      'Settings that need a server restart (unloading on idle, where to compute) are not ' +
      'applied at once during a run: a restart would cut the task. The server card says “will ' +
      'apply after the current run”, and the restart happens when there are no runs; the wait ' +
      'is kept in a file and survives a panel restart. If it fails there is one more attempt, ' +
      'then the card names the reason and the setting applies at the next server start.',
    longContinue: 'The run continues after a failure',
    longContinueText:
      'If a turn ends because of a server failure, the network or a timeout, the chat continues ' +
      'the same session itself: after 20, 60 and 180 seconds, at most three attempts in a ' +
      'row; the feed keeps a note for each. Any message from a human cancels the wait and ' +
      'resets the count. If a continuation did work (it ran several tools), the count ' +
      'starts over: a night with rare failures amid hours of work does not exhaust the limit. ' +
      'A run picked up after a panel restart is continued too, if it broke off. A stop by the ' +
      'button and errors a repeat does not cure are not continued. A pending attempt does not ' +
      'survive a panel restart.',
    longMemory: 'Task memory and deadlines',
    longMemoryText:
      'The local-model kit tells the agent to create `.agent/PROGRESS.md` in the project, ' +
      'update it step by step and read it after the context is compacted; the compaction hints ' +
      'are scaled to the local model window, not the cloud one. While the server watch follows a ' +
      'request, the first-byte deadline is only a six-hour safety net: silence without progress ' +
      'decides a cut, not a calculation from the measured speed. Without the watch, model reply ' +
      'deadlines start at five minutes and grow with the context: a full prompt takes longer ' +
      'than a minute. The run event buffer kept for reconnecting a screen is bounded (4000 ' +
      'events, 4 MB): the oldest go, and a screen that fell further behind sees a note about it.',
    mcpTitle: 'MCP servers of the local run',
    mcpCaption:
      'By default a local run gets the full set, like cloud Claude: every MCP server, skill and hook. ' +
      'The lean set is switched on in the contour card; then the chat header in a project shows the “MCP: N” button, ' +
      'and the lean set has no servers by default. In the full set through the panel’s gateway ' +
      'the model does not get MCP tool descriptions up front: a request carries only their names, ' +
      'and a tool gets its description on first use through tool search (ToolSearch). Measured ' +
      '15.10 on Qwen3.8 27B: the first request is 23 thousand tokens instead of 71 thousand; once ' +
      'the tool is loaded, later requests recompute 59–166 tokens out of 22 thousand. This holds for ' +
      'conversations started with tool search: resuming an older conversation, Claude Code repeats ' +
      'its earlier tool set whole so the cache stays intact. The chat marks such a conversation with a ' +
      'line naming the tokens of those descriptions — a new chat gets rid of them.',
    mcpWhy: 'Why the lean set has none by default',
    mcpWhyText:
      'Tool descriptions ride in every request and take model window. Measured on 14 Oct: one ' +
      'GitLab server with 39 tools is about 15 thousand tokens, while the request base without ' +
      'MCP is about 12.6 thousand. In a 64K window history compaction starts near 44 thousand.',
    mcpHow: 'How to choose',
    mcpHowText:
      'Open “MCP: N”: every server from the settings and from the project .mcp.json shows its ' +
      'cost in tokens (with “~” when the model server is not running and the cost is estimated ' +
      'from schema length) and the window left for the conversation. Tick what you need — the ' +
      'choice is remembered for the project and applies from the next message; the layers ' +
      'caption in the header names the chosen ones. A server that would leave under four ' +
      'thousand tokens for the conversation is locked. Servers from the project .mcp.json are ' +
      'never started on their own: their cost appears after “Measure again”.',
    mcpHonest: 'What this does not change',
    mcpHonestText:
      'The choice applies only to a local run with the lean set. A project copy (a branch in a ' +
      'separate folder) is a different directory, and its choice is made separately.',
    deviceMac: 'Mac with an M chip',
    deviceMacText:
      'On a Mac (M1 and newer) the “video card” is the chip GPU on unified memory. There is no ' +
      'way to hide it from the server, so the “processor” choice may have no effect on a Mac — ' +
      'the section says so plainly. The chip memory bandwidth comes from the reference table; a ' +
      'chip not in it yet (M6, M7…) takes the newest known chip of the same tier (base, Pro, ' +
      'Max, Ultra), marked as an estimate.',

    claudeTitle: 'Claude Code on this model',
    claudeCaption: 'A checkbox in the agents card, “For agents” tab. Off by default.',
    claudeOn: 'Turn on',
    claudeOnText:
      'The panel writes into the env section of Claude settings.json the model server address, ' +
      'the model for every role (subagents included) and the server context window. Claude Code ' +
      'itself — terminal, editor chat, panel chats — goes to the local model. The model choice in ' +
      'Claude Code (/model in the terminal, the list in the editor) shows one row with its name ' +
      'instead of Opus and Sonnet. New sessions pick it up at once; start an open session again. ' +
      'The panel’s helpers (the panel agent, the form helper, the assistant window, the watcher, ' +
      'group service calls) start Claude without your settings — the panel passes them the same ' +
      'variables itself, so they answer with the local model too.',
    claudeOff: 'Turn off',
    claudeOffText:
      'Restores these variables exactly as they were before switching on; nothing else in the ' +
      'file is touched. A variable you changed by hand after switching on is left as it is and ' +
      'named.',
    claudeWhile: 'While on',
    claudeWhileText:
      'settings.json beats launch variables, so a Claude run through another contour is refused ' +
      'with an explanation instead of silently going to the local model. The panel chat header ' +
      'locks the model choice to its name: Opus cannot be picked, it would answer anyway. Change ' +
      'the model or the device and the panel rewrites the context window itself.',

    kitTitle: 'Whose kit the agent gets',
    kitCaption:
      'The kit mode is chosen separately for Claude Code, Qwen Code and Codex. On a local model the kit ' +
      'gets its own variant: a short discipline block for a small model, tool calls one at a time, ' +
      'background commands refused (a background subagent is allowed), and for Qwen Code a map of its own tool names. The kit itself, ' +
      'editing and the check against the global layer live in the «Panel kit» section.',
    kitHeader: 'Mode',
    kitWhat: 'What the agent gets',
    kitGlobal: 'Yours',
    kitGlobalText:
      'Your skills, hooks and rules — exactly as in normal work. The default when you have a layer of your own. ' +
      'The local-model discipline block (one subagent at a time, no reviewer fan-out) reaches the agent in this mode too.',
    kitOurs: 'Panel kit only',
    kitOursText:
      'The panel’s rules and skills; your personal settings are not loaded. Project files (.claude ' +
      'in the repository) stay — without them the agent does not know the project. The caps a ' +
      'personal settings.json usually holds reach Claude Code as launch variables: command output up ' +
      'to 8000 characters, a file read up to 10,000 tokens; a cap of its own in the group profile ' +
      'overrides them.',
    kitHybrid: 'Yours plus the panel kit',
    kitHybridText:
      'Your kit with the panel’s on top. For Claude Code and Codex (Codex gets the rules and ' +
      'skills only); Qwen Code has no way to add a kit for a single run. The default for Claude Code and ' +
      'Codex while you have no layer of your own: no skills, commands, subagents, CLAUDE.md or AGENTS.md.',

    runtimeTitle: 'Where the model server comes from',
    runtimeText:
      'The panel downloads its own llama.cpp build from a GitHub release: the build number is pinned in the ' +
      'panel, and an update is a deliberate edit together with a check of the launch flags. For an NVIDIA card ' +
      'it takes the CUDA build matching the driver and a separate archive with the CUDA libraries; for other cards Vulkan, on a Mac Metal, ' +
      'without a card the CPU build. The checksum is compared with the one GitHub computed when the file was uploaded; ' +
      'a mismatch deletes the file and it is downloaded again. On Linux the CUDA libraries land beside llama-server: that is the only place ' +
      'the server looks for them, otherwise it would silently run on the CPU. A server that cannot start (no execute bit, a noexec volume) ' +
      'ends the launch with that error. Your own llama-server can be set with the LLAMA_SERVER_BINARY variable.',
    importTitle: 'Models already downloaded in Ollama',
    importLead:
      'The weights layer in the Ollama store is a plain GGUF. The panel attaches it with a hard link and tries to open ' +
      'it in llama.cpp without the graphics card; Ollama is neither started nor changed.',
    importOk: 'It opened: the model is installed',
    importOkText:
      'The model appears in the installed list with the real quantization read from the file (for example Q4_K_M) and the mark “imported from Ollama”. The MTP layer (if the file has one) is found by the panel ' +
      'itself and generation speeds up — on Qwen3.6 27B that is 82 tokens a second instead of 47.',
    importFail: 'It did not open: download again',
    importFailText:
      'A format or architecture this build lacks cannot be opened by llama.cpp. The link is removed, the reason ' +
      'is shown in the section and the model is offered for a fresh download from Hugging Face.',
    importOwn: 'The panel’s own previous store',
    importOwnText:
      'Models the panel downloaded while Ollama was the server (the .local-models/models folder) are taken over ' +
      'on the first start by themselves. The system Ollama store is not touched like that: its models are taken over with a button.',

    filesTitle: 'Where things live',
    filesCaption:
      'Everything is in one panel folder, .local-models. Deleting it deletes both the server and the models.',
    filesPanelTitle: 'The .local-models folder',
    fileRuntime: 'Model server (own copy)',
    fileModels:
      'Models: GGUF files by repository; ollama-import/ holds the ones taken over from Ollama',
    fileDownloads: 'Partial downloads',
    fileTools: 'Qwen Code and its kit',
    fileLogs: 'Server log',
    fileRecord: 'Running server: port, model file, quantization, context, device and context cache',
    fileSlots: 'Read-prompt cache per conversation: a .bin file and its .json description',
    fileState:
      'Measurements, kit choice, quantization and context choice, run-layer measurements, added ' +
      'custom models',
    fileImport:
      'A model file from Ollama (a store layer) is attached by a hard link — no second copy on disk. If the ' +
      'folders are on different drives a link is impossible, and the file is copied.',

    limitsTitle: 'What a local model cannot do',
    limitWeakerTitle: 'It is weaker than the cloud',
    limitWeakerText:
      'Long tasks, large edits and multi-step plans come out noticeably worse on a local model. ' +
      'The panel kit helps it stick to the rules, but does not make it equal to the cloud.',
    limitContextTitle: 'Context is per server',
    limitContextText:
      'The context is set when the server starts. Another model with another context means a ' +
      'server restart, and the previously loaded model is unloaded. The context cache is normally ' +
      'q8_0; it is compressed to q4_0 when that fits a longer context entirely on the GPU, and when ' +
      'the model fits on the card only partly — the model row says “cache q4_0”. The fit takes free ' +
      'video memory from the driver and adds what our own server holds, measured for its process: ' +
      'llama-server itself on Windows counts the memory it already holds as free. If after loading ' +
      'the server still spilled into shared memory by more than 768 MiB (on Windows that is not an ' +
      'error but a slowdown of tens of times: measured 15.10 — 0.6 tokens per second instead of ' +
      '81.7), the panel restarts it and fits again by itself. On Windows the memory held by the browser and other ' +
      'programs is handed to the model on demand, so the fit does not cut the context because of it. ' +
      'For qwen3.6:27b-coding and qwen3.8:27b the default is the IQ4_XS quantization (UD-IQ4_XS for ' +
      '3.8) and a 131,072 window: that way the model with the full Claude Code set fits entirely on a ' +
      '24 GB card, and the cache is fitted to free memory; with Q4_K_M that window fits only with a q4_0 cache. ' +
      'A pick in the “Context” list beats the default and is remembered, ' +
      'and while the same server runs, a repeated start keeps the cache and offload it already fitted. ' +
      'Left alone, Qwen3.8 27B reasons at the “extra high” level, tens of thousands of tokens per turn, so the ' +
      'server starts with reasoning effort medium (--chat-template-kwargs); a request carrying its own effort overrides it. ' +
      'Qwen3.8 27B also runs with its own chat template (--chat-template-file): the one inside the model file rejected a ' +
      'system message anywhere but first, Claude Code sends one in every request, and the server refused them all. ' +
      'When a new panel version changes that template, a server started with the old one restarts by itself. ' +
      'Claude Code in such a run gets the server’s real window and compacts the history early; a ' +
      'request that no longer fits the window is refused by the gateway with «prompt is too long», ' +
      'which Claude Code answers by compacting — the start of a request is never cut silently. The run ' +
      'layer — system prompt and tool schemas — is measured by the gateway on every request with tools. ' +
      'If, together with the reply reserve, it leaves no room for the conversation, every turn would get ' +
      'that refusal: then the server line in the chat, the chat itself between turns and the server card ' +
      'show the layer, window and limit and one action — raise the window to the nearest sufficient one, ' +
      'and if the current quantization cannot carry that window on the card, pick one that can. The panel ' +
      'never trims the set itself: that is the human’s decision on the contour card. The server ' +
      'takes minutes over a long request, and that is not a hang: while a turn runs, a server line under ' +
      'the chat messages shows the model, quantization, window and stage — loading, reading the prompt (how ' +
      'many tokens of how many), answering, waiting for permission. Only silence without progress counts as a ' +
      'stall: two minutes on the GPU, ten on the CPU; a server that answers the health check but stays silent ' +
      'about its slot shows no progress. Then the request is cut with the reason and sent again, ' +
      'and a server stuck mid-prompt is restarted; after 20 seconds of silence the line offers a restart ' +
      'button. A refusal from the server itself (a 4xx/5xx code other than 503 “loading model”) shows on the line in red with its code and ' +
      'text until the next request goes through. If the server is not running and the chat goes to the local model, the first request starts ' +
      'it and waits for the load. If it does not come up, the next try comes no sooner than 30, then 60 ' +
      'seconds later; after the third failure requests get a refusal with the cause from the server log ' +
      'until the server is started or restarted by hand or the model choice changes. The previous server ' +
      'run keeps its log next to it, in llama.prev.log.',
    limitEstimateTitle: 'An estimate is not a measurement',
    limitEstimateText:
      'The catalog speed is computed from the card’s bandwidth. The real number depends on the ' +
      'driver and the load on the card — “Measure” gives it.',
    limitMemoryTitle: 'Video memory stays taken while the server runs',
    limitMemoryText:
      'While the model is in use it holds video memory; after an idle period (5 minutes, adjustable) the ' +
      'server unloads it itself (unless “Keep loaded” is on) and the memory is freed. ' +
      '“Stop and free memory” stops the server at once; the next request starts it again.',
    limitLocalTitle: 'This machine only',
    limitLocalText:
      'The server listens on 127.0.0.1. You cannot share the model with colleagues from here — ' +
      'that is what a company contour is for.',

    datasetsTitle: 'Are datasets or fine-tuning needed?',
    datasetsText:
      'No. The catalog models are already trained to write code and work as agents. Fine-tuning ' +
      'on a home card does not make the agent noticeably better, and the agent learns the project ' +
      'by reading the repository and the rules. Sampling settings (temperature, top_p) are ' +
      'already set in the model by its authors, and Claude Code does not override them — there ' +
      'is nothing to tune.',
  },

  shots: {
    first: {
      '01-machine':
        'First visit: a 24 GB RTX 4090 detected, no model server installed, the catalog marked for the card',
      '02-catalog':
        'The catalog: “Recommended” on Qwen3.8 27B, Qwen3.6 27B Coding next; “partly in system memory” on the big ones, “not an agent” on models without tools',
      '03-pulling': 'Downloading a model: the bar, 7.1 of 16.5 GB, speed and time left',
      '04-ready':
        'Ready: the server on port 11435, “Where to compute” set to the video card, the model fully on it',
      '05-agents':
        'Agents on the local model, “Back to the cloud”, the “Claude Code on this model” checkbox off, Qwen Code and the kit',
    },
    choice: {
      '01-selects':
        'The Qwen3.6 27B Coding card: the “Launch settings” block next to the estimate, “Quantization” Q4_K_M downloaded, “Context” 64K, the measurement labelled with its context and quantization',
      '02-other-quant':
        'UD-Q4_K_XL selected, not on disk: a “Download” button with its size, “Hand to agents” and “Measure” hidden, the measurement marked stale',
      '03-restart':
        'A 96K context chosen on a loaded model: “Restarting with the new settings…”, the row recomputed for 96K',
      '04-custom-form':
        'The “Repository or link” field with unsloth/Qwen3-14B-GGUF typed in and the “Add” button',
      '05-custom-row':
        'The added model: “Custom” and “Tool calling not verified” marks, quantization sizes from the repository, the same two lists',
      '06-files':
        '“On disk”: Q4_K_M is loaded into the server and has no trash button, UD-Q4_K_XL has one; the whole-model trash button in the header is closed',
      '07-confirm':
        'The quantization delete dialog: what goes away, how much space is freed, and that the other quantizations stay',
    },
  },

  diagrams: {
    'from-button-to-gpu':
      'From the button to the graphics card: what the panel installs itself and which way an agent’s request goes',
  },
};
