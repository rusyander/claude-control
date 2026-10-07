import type { kitRu } from '../../ru/topics/kit';

/** Typed against the Russian topic: a key cannot be forgotten in translation. */
export const kitEn: typeof kitRu = {
  topic: {
    title: 'Panel kit',
    summary:
      'Skills, pipelines, subagents, rules and hooks that ship with the panel: a mode per CLI, a check against the global layer, editing',
    lead:
      'The panel kit is a ready working set for the agent: skills, multi-step pipelines, ' +
      'subagents, rules and hooks. It lives inside the app and joins a run through a launch ' +
      'flag — your `~/.claude` folder does not change. The section shows how the kit differs ' +
      'from your global layer and moves items either way with one button.',

    guideTitle: 'What this document covers',
    guideText:
      'First the diagram — how the kit reaches a run. Then the path frame by frame: mode, items, ' +
      'the difference from the global layer, moving. Then which CLI supports which mode, where ' +
      'the files are and what the kit does not do.',

    whyOne: 'One kit for every run',
    whyOneText:
      'Chat, groups and test runs all receive the same thing — whatever the mode selects. The kit ' +
      'updates with the panel instead of being rewritten by hand on every machine.',
    whyClean: 'No traces in your folder',
    whyCleanText:
      'The kit joins one run through a launch flag. «Yours only» brings everything back to how ' +
      'it is without the panel: not a single file appears in or disappears from `~/.claude`.',
    whyYours: 'Your edits are not overwritten',
    whyYoursText:
      'An edited item is saved as your copy on top of the built-in text. A panel update changes ' +
      'the built-in text and keeps your copy; «Restore built-in» moves the copy to the archive.',

    mapTitle: 'How the kit reaches a run',
    mapCaption:
      'The built-in text and your copies are assembled into one folder per run; the CLI gets it ' +
      'through a flag and drops it when the run ends.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'Before a launch the panel looks up the kit mode for that CLI. «Yours only» adds nothing. ' +
      'Otherwise the panel assembles the run folder: the built-in kit, your copies on top, ' +
      'disabled items left out. Claude Code receives it through `--plugin-dir`; in «Panel kit ' +
      'only» also without your personal settings layer. Qwen Code on a local model receives an ' +
      'assembled home directory for that launch. Codex receives the rules through a launch key, ' +
      'after your own instructions, and the skills as the kit folder; its folder and ' +
      '`config.toml` stay unchanged. If the folder fails to build, the run does not ' +
      'start and says why, instead of silently running on your global layer; for Codex a kit ' +
      'whose rules together with the skill list exceed 24,000 characters is refused the same ' +
      'way — the command line holds no more, and the panel will not trim the rules silently; ' +
      'that refusal names the limit and the kit size. The way out is the «Yours only» mode; for ' +
      'a kit too large also switching off rules in it, for a folder that failed — another try.',

    modesTitle: 'Modes',
    modesCaption: 'The mode is chosen per CLI and applies from the next message.',
    modeHeader: 'Mode',
    modeWhat: 'What the agent gets',
    modeGlobal: 'Yours only',
    modeGlobalText:
      'The default. Only what is in `~/.claude` and its counterparts for other CLIs — as without the panel.',
    modeHybrid: 'Yours and the panel kit',
    modeHybridText:
      'Your layer plus the kit. For a same-named item yours is taken; such a row lets you choose «from the kit».',
    modeOurs: 'Panel kit only',
    modeOursText:
      'Only the kit: personal settings, rules and hooks are not loaded. The account login stays — it does not live in settings.',

    cliTitle: 'Which CLI supports what',
    cliCaption:
      'The kit joins a single run only. Where there is no way to do that, the CLI does not get it.',
    cliHeader: 'CLI',
    cliWhat: 'Modes',
    cliClaude: 'Claude Code',
    cliClaudeText: 'All three modes.',
    cliQwen: 'Qwen Code',
    cliQwenText:
      '«Panel kit only» while Qwen Code runs on a local model. Qwen Code has no per-launch layer, ' +
      'so it receives its own home directory: the rules in QWEN.md, the skills, commands, ' +
      'subagents and hooks as a kit extension. «Both» cannot be assembled without touching ' +
      '`~/.qwen`. The kit hooks know the run is local: the guard lets a single subagent through ' +
      'without asking, since on your own card it spends no subscription limit; a fan-out of many ' +
      'agents still asks.',
    cliCodex: 'Codex',
    cliCodexText:
      '«Yours only» and «Yours and the panel kit». Rules and skills get through: the rules via ' +
      'the `developer_instructions` key for that launch, after your own from `config.toml`; the ' +
      'skills as the kit folder: in the chat (codex app-server) Codex sees them as its own ' +
      'skills, and in a one-off launch (codex exec) it gets them as a «name — description — ' +
      'path to SKILL.md» list in the same instructions. Pipelines and subagents do ' +
      'not: Codex cannot take them for one launch. Hooks neither: Codex runs a hook only after ' +
      'it is approved in Codex itself. The panel does not touch `~/.codex`.',
    cliOther: 'The rest',
    cliOtherText:
      'They do not get the kit — the page names them and the reason: no way to attach it for one ' +
      'launch, or the CLI is not installed. The panel does not write into their folders.',

    globalTitle: 'Checking against the global layer',
    globalCaption: 'Every row shows how it relates to the same-named item in `~/.claude`.',
    globalHeader: 'Mark or button',
    globalWhat: 'Meaning',
    globalSame: 'Same as global',
    globalSameText: 'The texts match (line endings ignored).',
    globalDiffers: 'Differs from global',
    globalDiffersText:
      'In the editor — the «Difference» view: line by line, what is in the global layer and what is in the kit.',
    globalAbsent: 'Not in global',
    globalAbsentText: 'The item exists only in the kit.',
    globalTo: 'To global',
    globalToText:
      'The item, exactly as a run receives it, is written to `~/.claude`. Whatever was there goes ' +
      'to a backup first — it can be restored in «Change history». Only after confirmation.',
    globalFrom: 'From global',
    globalFromText:
      'The global version becomes your copy in the kit. The built-in text does not change; the ' +
      'previous copy goes to the kit archive.',
    globalTake: 'Take into kit',
    globalTakeText:
      'At the bottom of the page — your skills, commands and subagents that the kit lacks. A ' +
      'taken item becomes an «Added by you» row and rides with the run.',

    filesTitle: 'Where things are',
    filesCaption: 'Paths in the panel data folder — next to your configuration.',
    filesPanelTitle: 'Panel kit',
    fileBuiltin: 'Built-in kit (inside the app)',
    fileMine: 'Your copies',
    fileArchive: 'Archive: reset and replaced copies',
    fileState: 'Modes, disabled items, the choice on a name clash',
    fileEffective: 'Run folder — rebuilt before every launch',

    limitsTitle: 'What the kit does not do',
    limitRulesTitle: 'Rules and hooks stay inside the kit',
    limitRulesText:
      'Skills, commands and subagents move to and from the global layer. A kit rule is loaded by ' +
      'the kit’s own hook, and a hook is tied to the shared `hooks.json` — they cannot move one file at a time.',
    limitHooksTitle: 'A broken hooks.json is not saved',
    limitHooksText:
      'If the text is not JSON of the form {"hooks": {…}}, saving is refused at once: otherwise ' +
      'every run in a kit mode would fail while assembling.',
    limitKeysTitle: 'The kit holds no keys',
    limitKeysText:
      'Items that need a tracker or a knowledge base take access from «Settings → ' +
      'Integrations». Not connected — the item says so and skips its step instead of asking for ' +
      'a key in chat.',
    limitEnglishTitle: 'Text for the model is in English',
    limitEnglishText:
      'The model reads the kit’s skills, rules and pipelines in English: shorter and more precise. ' +
      'The page and its hints follow the panel language.',
  },

  shots: {
    page: {
      '01-modes':
        'A mode per CLI: Claude Code supports all three, the rest are named with a reason',
      '02-items':
        'Kit skills: «Built-in», «Changed by you», check marks and the «To global» / «From global» buttons',
      '03-diff':
        'Editor: the «Difference» view — what is in the global layer and what is in the kit, line by line',
      '04-global-only': 'Only in the global layer: «Take into kit»',
    },
  },

  diagrams: {
    'kit-to-run':
      'From the kit to a run: built-in text, your copies and the mode assemble into one launch folder',
  },
};
