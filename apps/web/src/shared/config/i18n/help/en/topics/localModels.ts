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
      'the model server and the model, starts the server with the right context and sets up the ' +
      'local-model contour — everything that used to be installed and configured by hand. The ' +
      'cloud comes back in one click.',

    guideTitle: 'What this document covers',
    guideText:
      'First a diagram of where an agent’s request goes. Then the section frame by frame, from ' +
      'the first visit to agents on your own card. After that: what the catalog marks mean, ' +
      'whose kit the agent gets, where the files live and what a local model cannot do.',

    whyFit: 'For your card, not in general',
    whyFitText:
      'Every catalog model is marked for THIS machine: whether it fits in video memory, with what ' +
      'context and how many tokens per second it gives. The estimate comes from the card’s memory ' +
      'bandwidth; “Measure” measures the real speed.',
    whyOne: 'One button instead of a manual',
    whyOneText:
      'Model server, environment variables, context, the address for Claude Code — the panel does ' +
      'it all. The work runs on the panel’s server: closing the tab does not stop a download, and ' +
      'an interrupted download resumes where it stopped.',
    whyBack: 'The cloud is one click away',
    whyBackText:
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
      'server on 127.0.0.1:11435, which holds the model in video memory. The contour’s mode is ' +
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
        'at the top of the section does all three in a row — on a clean machine it installs the server too.',
      firstMachine: 'First visit: card detected, no server yet',
      firstMachineText:
        'On the left is your machine: the card, its video memory and how much is free, bandwidth, ' +
        'RAM and disk space. On the right is the model server: if Ollama is already installed, ' +
        'the section uses it; if not, “Download” puts its own copy into the panel folder.',
      firstCatalog: 'The catalog for this card',
      firstCatalogText:
        'Each model shows how it was trained (for code, tuned for code or general), whether it ' +
        'fits, its context, how much memory it needs and the speed estimate. “Recommended” is the ' +
        'best one for an agent on this machine. A red line under a model says why it will not do ' +
        'for an agent.',
      firstPulling: 'Downloading',
      firstPullingText:
        'A bar, the speed and the time left. “Cancel” stops the download but keeps what was ' +
        'fetched: the next click resumes where it stopped.',
      firstReady: 'The model is ready',
      firstReadyText:
        'The server is running and holds the model in memory — you can see how much video memory ' +
        'it takes. “Measure” measures the real speed and shows it next to the estimate. “Used by ' +
        'agents” means this model is answering chats right now. “Where to compute” is the video ' +
        'card or the processor, and the “In memory” line tells where the model actually went.',
      firstAgents: 'Agents and the kit',
      firstAgentsText:
        'Which model the agents use now, and the “Back to the cloud” button. The “Claude Code on ' +
        'this model” checkbox (off) sends Claude Code itself there too. Below are Qwen Code ' +
        'and the kit choice: whose skills, hooks and rules the agent gets while it runs on the ' +
        'local model.',
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
    deviceCaption: 'The switch is in the model server card. The video card by default.',
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
    deviceMac: 'Mac with an M chip',
    deviceMacText:
      'On a Mac (M1 and newer) the “video card” is the chip GPU on unified memory. There is no ' +
      'way to hide it from the server, so the “processor” choice may have no effect on a Mac — ' +
      'the section says so plainly. The chip memory bandwidth comes from the reference table; a ' +
      'chip not in it yet (M6, M7…) takes the newest known chip of the same tier (base, Pro, ' +
      'Max, Ultra), marked as an estimate.',

    claudeTitle: 'Claude Code on this model',
    claudeCaption: 'A checkbox in the agents card. Off by default.',
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
      'gets its own variant: shorter rules and a more explicit tool-call format. The kit itself, ' +
      'editing and the check against the global layer live in the «Panel kit» section.',
    kitHeader: 'Mode',
    kitWhat: 'What the agent gets',
    kitGlobal: 'Yours (default)',
    kitGlobalText: 'Your skills, hooks and rules — exactly as in normal work.',
    kitOurs: 'Panel kit only',
    kitOursText:
      'The panel’s rules and skills; your personal settings are not loaded. Project files (.claude ' +
      'in the repository) stay — without them the agent does not know the project.',
    kitHybrid: 'Yours plus the panel kit',
    kitHybridText:
      'Your kit with the panel’s on top. For Claude Code and Codex (Codex gets the rules and ' +
      'skills only); Qwen Code has no way to add a kit for a single run.',

    filesTitle: 'Where things live',
    filesCaption:
      'Everything is in one panel folder, .local-models. Deleting it deletes both the server and the models.',
    filesPanelTitle: 'The .local-models folder',
    fileRuntime: 'Model server (own copy)',
    fileModels: 'Models',
    fileDownloads: 'Partial downloads',
    fileTools: 'Qwen Code and its kit',
    fileLogs: 'Server log',
    fileRecord: 'Running server: port, context, device and context cache',
    fileState: 'Measurements and kit choice',
    fileImport:
      'A model from the system Ollama is moved by a hard link — no second copy on disk. If the ' +
      'folders are on different drives a link is impossible, and the model is copied.',

    limitsTitle: 'What a local model cannot do',
    limitWeakerTitle: 'It is weaker than the cloud',
    limitWeakerText:
      'Long tasks, large edits and multi-step plans come out noticeably worse on a local model. ' +
      'The panel kit helps it stick to the rules, but does not make it equal to the cloud.',
    limitContextTitle: 'Context is per server',
    limitContextText:
      'The context is set when the server starts. Another model with another context means a ' +
      'server restart, and the previously loaded model is unloaded. The context cache is normally ' +
      'q8_0; it is compressed to q4_0 when that fits a longer context entirely on the GPU, and a ' +
      'note under the «Context» line says so. On Windows the memory held by the browser and other ' +
      'programs is handed to the model on demand, so the fit does not cut the context because of it.',
    limitEstimateTitle: 'An estimate is not a measurement',
    limitEstimateText:
      'The catalog speed is computed from the card’s bandwidth. The real number depends on the ' +
      'driver and the load on the card — “Measure” gives it.',
    limitMemoryTitle: 'Video memory comes back on its own',
    limitMemoryText:
      'A model nobody used for 10 minutes is unloaded. “Stop and free memory” unloads it at once ' +
      'and stops the server.',
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
        'The catalog: “Recommended” on Qwen3.6 27B Coding, “partly in system memory” on the big ones, “not an agent” on models without tools',
      '03-pulling': 'Downloading a model: the bar, 7.1 of 16.5 GB, speed and time left',
      '04-ready':
        'Ready: the server on port 11435, “Where to compute” set to the video card, the model fully on it, measured 61.4 tok/s, “Used by agents”',
      '05-agents':
        'Agents on the local model, “Back to the cloud”, the “Claude Code on this model” checkbox off, Qwen Code and the kit',
    },
  },

  diagrams: {
    'from-button-to-gpu':
      'From the button to the graphics card: what the panel installs itself and which way an agent’s request goes',
  },
};
