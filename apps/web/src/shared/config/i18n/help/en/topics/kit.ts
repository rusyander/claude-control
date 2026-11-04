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
      'The mode is picked once per CLI, not for every conversation or run. The kit ' +
      'updates with the panel instead of being rewritten by hand on every machine.',
    whyClean: 'No traces in your folder',
    whyCleanText:
      'The kit joins one run through a launch flag. «Yours only» brings everything back to how ' +
      'it is without the panel: not a single file appears in or disappears from `~/.claude`. ' +
      'Guards your layer lacks reach Claude Code through the same flag, for that run.',
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
      'Before a launch the panel looks up the kit mode for that CLI. «Yours only» adds only the ' +
      'kit guards missing from your `~/.claude/hooks/lib`: consent to git writes, the ban on ' +
      'merging MRs and PRs, destructive commands, secrets, `nvm use` (on Windows it takes Node ' +
      'away from the whole machine), pipeline waiting. A guard whose namesake twin ' +
      'is in your layer yields to it, so no call is answered twice. Otherwise the panel assembles the run folder: the built-in kit, your copies on top, ' +
      'disabled items left out. Claude Code receives it through `--plugin-dir`; in «Panel kit ' +
      'only» also without your personal settings layer. Qwen Code on a local model receives an ' +
      'assembled home directory for that launch. Codex receives the rules and the skill list ' +
      'as text in the session instructions, after the core brief; its folder and ' +
      '`config.toml` stay unchanged. If the folder fails to build, the run does not ' +
      'start and says why, instead of silently running on your global layer. For Codex the kit ' +
      'gets 28,000 characters of the instructions field (the rest is kept for the tests line): ' +
      'when the skill list does not fit next to the rules, it shrinks — descriptions cut to 240 characters, then names ' +
      'only; a kit whose rules exceed the limit even then is refused the same way, ' +
      'because the panel will not trim the rules silently; ' +
      'that refusal names the limit and the kit size. The way out is the «Yours only» mode; for ' +
      'a kit too large also switching off rules in it, for a folder that failed — another try.',

    modesTitle: 'Modes',
    modesCaption: 'The mode is chosen per CLI and applies from the next message.',
    modeHeader: 'Mode',
    modeWhat: 'What the agent gets',
    modeGlobal: 'Yours only',
    modeGlobalText:
      'The default when you have a layer of your own. What is in `~/.claude` and its counterparts ' +
      'for other CLIs — as without the panel. Claude Code also gets only the kit guards your layer ' +
      'lacks, so the merge ban and git-write consent are the same on any machine.',
    modeHybrid: 'Yours and the panel kit',
    modeHybridText:
      'Your layer plus the kit. For a same-named item yours is taken; such a row lets you choose «from the kit». ' +
      'If Claude Code or Codex is not set up — no skills, commands, subagents, CLAUDE.md or AGENTS.md — ' +
      'this mode is the default: otherwise a run would go without the skills that review, conflicts, tests ' +
      'and MR delivery rely on.',
    modeOurs: 'Panel kit only',
    modeOursText:
      'Only the kit: personal settings, rules and hooks are not loaded. The account login stays — it does not live in settings. ' +
      'The kit sets the window caps itself: a command answer in the conversation is up to 8000 characters (longer — the ' +
      'head and a path to the file with the full output), one file read is up to 10,000 tokens. A group task step ' +
      'gets the kit rules as a short card with the path to the full text — after every compaction too.',

    cliTitle: 'Which CLI supports what',
    cliCaption:
      'The kit joins a single run only. Where there is no way to do that, the CLI does not get it.',
    cliHeader: 'CLI',
    cliWhat: 'Modes',
    cliClaude: 'Claude Code',
    cliClaudeText:
      'All three modes. On a local model tool calls run one at a time, and the kit refuses ' +
      'background commands: the model would poll them and spend its window. A background subagent ' +
      'is allowed: the turn ends, the subagent works, and its result wakes the turn again. The ' +
      'local-model rule (including the .agent/PROGRESS.md part) travels in every mode; the kit ' +
      'hooks — the compaction reminder, thresholds scaled to the local window, the checkpoint ' +
      'before compaction — only in “Yours and the panel kit” and “Panel kit only”.',
    cliQwen: 'Qwen Code',
    cliQwenText:
      '«Panel kit only» while Qwen Code runs on a local model. Qwen Code has no per-launch layer, ' +
      'so it receives its own home directory: the rules in QWEN.md, the skills, commands, ' +
      'subagents and hooks as a kit extension. «Both» cannot be assembled without touching ' +
      '`~/.qwen`. The kit hooks know the run is local: the guard lets a single subagent through ' +
      'without asking, since on your own card it spends no subscription limit; a fan-out of many ' +
      'agents still asks. The local-model rule tells the agent to keep .agent/PROGRESS.md: create it, update it step by step and read it after compaction. ' +
      'It arrives only in this mode: with “Yours only” Qwen Code does not get it — there is nothing to deliver for a single launch ' +
      'and the panel will not touch `~/.qwen`, so on an overnight Qwen Code run task memory rests on this mode. Kit rules and skills name Claude tools, so QWEN.md also carries a map ' +
      'of Qwen Code tool names; background work is refused here too.',
    cliCodex: 'Codex',
    cliCodexText:
      '«Yours only» and «Yours and the panel kit». Rules and skills get through: a Codex ' +
      'conversation is a core task, and the kit rides as text in the session instructions after ' +
      'the core brief — the rules, then the skills as a «name — description» list; Codex reads ' +
      'the skills themselves from the kit folder, the path to SKILL.md stands once in the list heading — a folder ' +
      'template with an example, so no skill spends a hundred characters of the limit on it. On a local model, or when the list does not fit the limit, its descriptions are cut to 240 characters, and if it still does not fit only names remain. Pipelines and subagents do ' +
      'not: Codex cannot take them for one launch. Hooks neither: Codex runs a hook only after ' +
      'it is approved in Codex itself, so they cannot be attached for a launch — the hooks variant is ' +
      'installed by hand, see the section below. The panel does not touch `~/.codex`.',
    cliOther: 'The rest',
    cliOtherText:
      'They do not get the kit — the page names them and the reason: no way to attach it for one ' +
      'launch, or the CLI is not installed. The panel does not write into their folders. The kit ' +
      'hooks can be installed into some of them by hand — see the section below.',

    hooksTitle: 'Kit hooks in other CLIs',
    hooksCaption:
      'The economy and guard hooks are the same for every CLI: the kit dispatcher judges each call, and ' +
      'the answer goes back in the form this CLI reads. Where they act is shown on the «Who gets the ' +
      'kit» card, in the «Where the kit hooks act» line.',
    hooksHeader: 'How they arrive',
    hooksWhat: 'CLI and what to do',
    hooksRun: 'On every launch',
    hooksRunText:
      'Claude Code and Qwen Code (on a local model, «Panel kit only»): the panel attaches the hooks ' +
      'itself, nothing to do.',
    hooksVariant: 'A variant you install',
    hooksVariantText:
      'Codex, Gemini CLI, Goose, Kimi Code, OpenCode. They cannot take hooks for one launch, so you ' +
      'install the variant from `apps/server/assets/kit/variants/<cli>` yourself, following the README ' +
      'beside it: Gemini CLI — as an extension in `~/.gemini/extensions`, Goose — as a plugin in ' +
      '`.agents/plugins`, Kimi Code — as a `[[hooks]]` block in `config.toml` with the path to a kit ' +
      'copy, OpenCode — as a plugin file in `~/.config/opencode/plugins` plus the `AGENTDECK_KIT_DIR` ' +
      'variable. These CLIs have no «ask you» answer: such a call is refused with a request to ask in ' +
      'the chat first. OpenCode has no end-of-turn check — its turn-end event cannot hold a turn. Goose ' +
      'on Windows calls hooks through `sh`: Git for Windows must be on PATH. A full gate repeated ' +
      'with no edit in between is refused; on every CLI but Claude Code the kit takes past gates ' +
      'from its own session log and counts as run only a call whose execution the post-call hook ' +
      'confirmed: one refused by you, by the CLI’s own rules or by another hook is not a run and ' +
      'does not hold the next gate. A CLI with no post-call hook on its shell remembers no gate at all.',
    hooksNone: 'Do not act',
    hooksNoneText:
      'Continue — `cn` has a hook format, but release 1.5.47 never calls it (checked by a run); ' +
      'Cursor — the panel does not launch it; Aider — it has no tool calls, nothing to intercept.',

    watchTitle: 'Live watching ships with the kit',
    watchCaption:
      'The watchdog skill is part of the kit: running agent work can be watched, and every ' +
      'deviation fixed at once, on any machine with the panel, with no personal copy of the skill ' +
      'in `~/.claude`. A core task step is a Claude Code session like any other, watched through ' +
      'its transcript.',
    watchStartTitle: 'How to start a watch on another machine',
    watchStartText:
      'Open a Claude Code chat in the «Yours and the panel kit» or «Panel kit only» mode (in «Yours ' +
      'only» the kit skills do not arrive) and ask it to watch the work. The agent creates a watch ' +
      'folder in the project (`.agent/tmp/watchdog/<name>`) and names what to watch: a session by ' +
      'id, the folder the agent works in, a transcript folder or file, a plain log. From then on one ' +
      'and the same `watch.mjs` call from the kit waits until something moves and wakes the agent on ' +
      'a deviation; while nothing happens, no tokens are spent. The watch folder lives in the ' +
      'project, so a resumed conversation and a compacted one both find it. The record for the turn ' +
      'hook (below) lives in the kit state folder (`AGENTDECK_KIT_STATE`, else the system temp ' +
      'folder), not in `~/.claude`.',
    watchHoldTitle: 'The turn does not end while the watch runs',
    watchHoldText:
      'At turn end a kit hook sends the agent back to the next watch call. The turn is released by ' +
      'your stop command, a `hold.json` file in the project’s `.agent/live-watch`, or the end of ' +
      'everything watched; after three refusals in a row with no new watch call it is released on its own. ' +
      'With no call for 10 minutes while the agent is busy elsewhere, one line reminds it of the ' +
      'watch — at most once per 10 minutes. Subagents and other sessions are not held. When the same ' +
      'hook sits in your personal layer and holds this turn, the kit hook stays silent — one turn is ' +
      'never answered twice.',

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
    limitCoreTitle: 'How the kit reaches a turn through the core',
    limitCoreText:
      'A chat turn runs as a core task, and the panel hands the kit to it as ' +
      'session fields: the kit and guard folders as plugins, the narrowed setting sources in ' +
      '«Kit only», the kit variables and its addition. The core attaches the plugin in a ' +
      'project without a trust mark too: the kit lives in the panel’s folder, not the ' +
      'repository’s (the repository’s own files still do not reach such a session). If the ' +
      'step’s layer hooks are narrowed by the scenario or a contour rule, the kit folder ' +
      'declares MCP servers or is missing, the chat does not start and names the reason and ' +
      'what to fix. Qwen Code «Ours» on a local model gets its own QWEN_HOME, Codex «both ' +
      'kits» gets the rules and the skill list after the core brief. The project local layer ' +
      '(«Projects» page) rides its own session field next to the kit: the setting sources ' +
      'drop «project», the layer’s instructions follow the core brief, its skills come as a ' +
      'plugin, its hooks and permissions go into the core settings; the approved .mcp.json ' +
      'servers are connected by the core itself. A conversation started from ' +
      'the core chat form (and «New ' +
      'conversation here» of another CLI) gets the kit the same way a chat turn does: the panel ' +
      'composes it. The Tests section agent on Claude Code gets the kit plugin, its variables ' +
      'and our layers, without the kit addition; an agent of another CLI runs without the kit. ' +
      'The form and resource-structure helper of another CLI gets the kit variables and rules ' +
      'text, Claude’s goes without the kit; a kit that needs more (plugins, narrowing) makes ' +
      'the helper refuse with the reason.',
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
