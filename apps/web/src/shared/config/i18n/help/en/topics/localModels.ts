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
      'Agents are switched through the contour, per run. Nothing is written to ~/.claude, and ' +
      '“Back to the cloud” restores everything as it was.',

    mapTitle: 'Where an agent’s request goes',
    mapCaption:
      'Left: what the human does; middle: the request’s path; right: where the model lives and what it cannot do.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'A chat, group or test starts Claude Code as usual. The panel gives it the address of its ' +
      'gateway; through the local-model contour the gateway passes the request to the model ' +
      'server on 127.0.0.1:11435, which holds the model in video memory. The contour’s mode is ' +
      '“required”: if the server does not answer, the request does not silently go to the cloud — ' +
      'it fails with a clear error.',

    guide: {
      firstTitle: 'Frame by frame: the section itself',
      firstCaption:
        'From the first visit to agents on your card. There are three buttons: “Download” for the ' +
        'server, “Download” for the model and “Hand to agents”; “Download and connect” under the ' +
        'chat does all three in a row.',
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
        'agents” means this model is answering chats right now.',
      firstAgents: 'Agents and the kit',
      firstAgentsText:
        'Which model the agents use now, and the “Back to the cloud” button. Below are Qwen Code ' +
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
    fileRecord: 'Running server: port and context',
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
      'server restart, and the previously loaded model is unloaded.',
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
      'by reading the repository and the rules.',
  },

  shots: {
    first: {
      '01-machine':
        'First visit: a 24 GB RTX 4090 detected, no model server installed, the catalog marked for the card',
      '02-catalog':
        'The catalog: “Recommended” on Qwen3.6 27B Coding, “partly in system memory” on the big ones, “not an agent” on models without tools',
      '03-pulling': 'Downloading a model: the bar, 7.1 of 16.5 GB, speed and time left',
      '04-ready':
        'Ready: the server on port 11435 holds the model in video memory, measured 61.4 tok/s, “Used by agents”',
      '05-agents':
        'Agents on the local model, “Back to the cloud”, Qwen Code and the kit choice for each CLI',
    },
    chat: {
      '01-hint':
        'Under the chat field: which model runs on this card and the “Download and connect” button',
      '02-busy': 'Download started from the chat: agents switch on their own when it finishes',
    },
  },

  diagrams: {
    'from-button-to-gpu':
      'From the button to the graphics card: what the panel installs itself and which way an agent’s request goes',
  },
};
