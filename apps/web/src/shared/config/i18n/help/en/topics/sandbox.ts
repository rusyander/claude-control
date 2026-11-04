import type { sandboxRu } from '../../ru/topics/sandbox';

/** Typed against the Russian topic: a key cannot be forgotten in translation. */
export const sandboxEn: typeof sandboxRu = {
  topic: {
    title: 'Sandbox',
    summary:
      'Check a rule, skill, hook or MCP server in isolation: its own settings directory, a conversation run as a core task, event probes without a model',
    lead:
      'The sandbox opens from the «Sandbox» button of a rule, skill, hook, command or MCP server. ' +
      'The panel builds a temporary settings directory holding only what you are testing and runs ' +
      'Claude Code inside it. Your `~/.claude` folder does not change, and everything built is ' +
      'removed when the window closes.',

    guideTitle: 'What this document covers',
    guideText:
      'First, why the sandbox exists and how each kind of setting is checked. Then the ' +
      'conversation frame by frame: composition, question, answer, refusal. After that, what ' +
      'exactly Claude Code sees inside and what the sandbox does not do.',

    whyIsolated: 'You see one setting at work',
    whyIsolatedText:
      'In a normal chat everything shapes the answer at once: your `CLAUDE.md`, project rules, ' +
      'other skills. The sandbox loads only what you picked, so a difference in the answer is the ' +
      'effect of the thing under test.',
    whySafe: 'Real settings stay untouched',
    whySafeText:
      'The sandbox is a separate settings directory and its own working folder. A hook that ' +
      'writes something and a skill that edits files act there, not in your folders.',
    whyCompare: 'Something to compare against',
    whyCompareText:
      'An empty sandbox answers the way Claude would without the setting: the same question there ' +
      'and in a sandbox with the rule shows what the rule changes.',

    kindsTitle: 'How each kind is checked',
    kindsCaption:
      'Hooks and MCP servers are checked directly, without a model. Rules and skills do not run on ' +
      'their own — they change how the model behaves, so a conversation checks them.',
    kindHeader: 'Tab',
    kindWhat: 'What it checks',
    kindProbe: 'Event probe',
    kindProbeText:
      'For hooks. The panel calls the hook script itself with prepared events or your JSON and ' +
      'shows the decision: passed, blocked, asked for confirmation. No model is involved — the ' +
      'answer is instant and free.',
    kindTools: 'Tools',
    kindToolsText:
      'For MCP servers. The panel starts the server, lists its tools and calls the one you pick ' +
      'with your parameters.',
    kindChat: 'Conversation',
    kindChatText:
      'For rules, skills and commands. The question goes to Claude Code inside the sandbox; the ' +
      'ready prompts above the field are built from the setting itself so that it shows up.',

    stepsTitle: 'The conversation step by step',
    stepsCaption: 'Four states of the window — from the composition to a core refusal.',
    stepComposition: 'Composition and boundaries',
    stepCompositionText:
      'On the right: what is loaded, where account access comes from and the sandbox boundaries. ' +
      '«Not found» under access means the conversation will not run: Claude Code answers «Not ' +
      'logged in».',
    stepWaiting: 'The question is sent',
    stepWaitingText:
      'While there is no answer, «Send» turns into «Stop». The first seconds go to launching the ' +
      'core task and starting the Claude Code session — it is not a hang.',
    stepAnswer: 'The answer',
    stepAnswerText:
      'The answer streams in. There is no turn price under it: the conversation runs as a core ' +
      'task, and the core does not report one — showing «$0.000» would be untrue.',
    stepRefused: 'The core refused',
    stepRefusedText:
      'If the core did not run the conversation, its reason is written under the button — in the ' +
      'interface language. Most often there is no account access or the core is not running.',

    insideTitle: 'What Claude Code sees inside',
    insideCaption:
      'Each question is a separate core task in the sandbox working folder. The core launches it ' +
      'with three settings, and each one closes its own gap.',
    insideHeader: 'Setting',
    insideWhat: 'Why',
    insideConfig: 'The sandbox settings directory',
    insideConfigText:
      'Claude Code gets the `CLAUDE_CONFIG_DIR` of the temporary directory. The value lives only ' +
      'in the core memory and is not written to the task journal.',
    insideSources: 'User layer only',
    insideSourcesText:
      'The sandbox working folder sits inside your home directory, and without this setting ' +
      'Claude Code would collect `CLAUDE.md` and `.claude` from every directory above it — up to ' +
      'your real one. So only the sandbox directory is read.',
    insideBrief: 'No core brief',
    insideBriefText:
      'For a normal task the core adds its own instructions. Here they would mix into the rule or ' +
      'skill under test, so the brief is off.',
    insideStop: '«Stop»',
    insideStopText:
      'The button tells the core to cancel the task; the session host cuts the Claude Code turn. ' +
      'Closing the window does the same.',

    notesTitle: 'Fine points',
    noteMemoryTitle: 'Every question starts clean',
    noteExpiredTitle: 'Two hours idle',
    noteApiKeyTitle: 'API key from the environment only',
    noteCoreTitle: 'The conversation needs the core',
    cantOtherCliTitle: 'Claude Code only',
    cantKeepTitle: 'The conversation is not kept',
    cantRealTitle: 'Not next to your settings',
    noteMemory:
      'Questions are not linked: each is a new task, and the model does not remember the previous ' +
      'answer. Need context — put it into the question itself.',
    noteExpired:
      'A sandbox is removed after two hours idle: a copy of account access should not sit on disk ' +
      'for hours. A question to a removed sandbox gets «removed for idling» — close the window and ' +
      'open it again, the composition is rebuilt. While an answer is running, the sweep leaves the ' +
      'sandbox alone.',
    noteApiKey:
      'API key access reaches the sandbox only when the key is set as an environment variable of ' +
      'the panel. A key from the Claude Code settings is not copied into the sandbox directory.',
    noteCore:
      'The conversation needs the core running — it is its own process beside the panel. The ' +
      'event probe and tool calls work without it.',

    cantTitle: 'What the sandbox does not do',
    cantOtherCli:
      'It does not work with other CLIs: the sandbox is built for the Claude Code settings ' +
      'directory, for the rest the tab is closed with a reason.',
    cantKeep:
      'It does not keep the conversation: the window closes and the directory is removed along ' +
      'with the answers. Liked an output — copy it before closing.',
    cantReal:
      'It does not check how the setting interacts with yours: to see a rule next to the others, ' +
      'turn it on and ask in a normal chat.',
  },

  shots: {
    conversation: {
      '01-composition':
        'The sandbox window of a rule: ready prompts, the question field, on the right the composition, access and boundaries',
      '02-waiting': 'The question is sent, no answer yet: «Send» turned into «Stop»',
      '03-answer': 'The answer from the sandbox: the rule showed up, no turn price',
      '04-refused': 'The core did not run the conversation: the refusal reason under the button',
    },
  },
};
