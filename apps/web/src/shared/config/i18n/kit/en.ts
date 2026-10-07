import type { kitRu } from './ru.ts';

/** English texts of the panel kit page; typed against the Russian module. */
export const kitEn: typeof kitRu = {
  title: 'Panel kit',
  subtitle:
    'Skills, pipeline commands, rules and hooks that ship with the panel. Switched on per CLI, without touching your ~/.claude.',
  loadError: 'Could not read the panel kit',
  openPage: 'Open "Panel kit" — items, editing, improving',
  version: 'Kit version {{version}}',
  modes: {
    title: 'Who gets the kit',
    what: 'A mode applies from the next message. Switching off leaves no trace: the kit is attached by a launch flag, not by files in your folder.',
    mode: {
      global: 'Yours only (default)',
      hybrid: 'Yours and the panel kit',
      ours: 'Panel kit only',
    },
    hint: {
      global:
        'The agent works with what is in this CLI’s own settings folder (~/.claude, ~/.qwen, ~/.codex), as without the panel.',
      hybrid:
        'Your skills, hooks and rules plus the panel kit. On a name clash yours wins unless chosen otherwise below.',
      ours: 'Panel kit only: your personal settings, rules and hooks are not loaded. Your sign-in stays.',
    },
    localOnly:
      'Applies when Qwen Code runs on the local model: Qwen Code has no per-launch layer, and "both kits" cannot be built without touching ~/.qwen.',
    carries:
      'Only {{carried}} reach it from the kit. Not reaching it: {{missing}} — {{title}} cannot take them for one launch without its folder being touched (and Codex runs a hook only after you approve it in Codex itself).',
    carriesKind: {
      skill: 'skills',
      command: 'pipelines',
      agent: 'subagents',
      rule: 'rules',
      hook: 'hooks',
    },
    unsupported: {
      'no-run-layer':
        'Do not get the kit: {{list}}. These CLIs have no way to attach it for one launch, and the panel will not write into their folders.',
      'not-installed': 'Not installed: {{list}}.',
    },
    saved: 'Kit mode saved',
  },
  tabs: {
    label: 'Kit sections',
    skill: 'Skills',
    command: 'Pipelines',
    agent: 'Subagents',
    rule: 'Rules',
    hook: 'Hooks',
    hint: {
      skill: 'Instructions the agent picks up itself when a task matches the description.',
      command:
        'Multi-step commands the agent walks in order. Call them as /agentdeck-kit:<name> in chat.',
      agent: 'Narrow-role helpers the agent launches itself: their own instructions and tool set.',
      rule: 'Rules the agent receives at the start of every session.',
      hook: 'Node scripts the CLI runs on events: session start, before a command.',
    },
  },
  kind: { skill: 'Skill', command: 'Pipeline', agent: 'Subagent', rule: 'Rule', hook: 'Hook' },
  item: {
    builtin: 'Built-in',
    modified: 'Changed by you',
    added: 'Added by you',
    enabledLabel: 'Enable "{{name}}"',
    open: 'Open',
    improve: 'Improve',
    conflict:
      'Your ~/.claude has one with the same name: {{path}}. In "Yours and the panel kit" mode the panel uses:',
    winner: { user: 'yours', kit: 'the kit one' },
    empty: 'Nothing in this kit section yet.',
  },
  global: {
    same: 'Same as global',
    differs: 'Differs from global',
    absent: 'Not in global',
    toGlobal: 'To global',
    fromGlobal: 'From global',
    toGlobalTitle: 'Write "{{name}}" to the global layer?',
    toGlobalText:
      'The file goes to {{path}} — every Claude Code session sees it, panel or not. Whatever was there is backed up first: restore it in Change history.',
    toGlobalConfirm: 'Write',
    fromGlobalTitle: 'Take "{{name}}" from the global layer?',
    fromGlobalText:
      'The global version becomes your copy in the kit. The built-in text stays, the previous copy goes to the kit archive.',
    fromGlobalConfirm: 'Take',
    exported: 'Written to the global layer',
    exportedBackup: 'Written to the global layer, the previous version is backed up',
    imported: 'Taken into the kit',
    onlyTitle: 'Only in the global layer',
    onlyHint:
      'Your skills, commands and subagents the kit does not have. "Take into kit" and they ship with the panel.',
    take: 'Take into kit',
  },
  editor: {
    title: '{{kind}} "{{name}}"',
    note: 'Saved as your copy over the built-in file: a panel update will not overwrite it. "Restore built-in" moves your copy to the kit archive.',
    field: 'Text',
    save: 'Save my copy',
    reset: 'Restore built-in',
    remove: 'Remove from kit',
    close: 'Close',
    saved: 'Your copy is saved',
    restored: 'Built-in text restored, your copy is in the kit archive',
    removed: 'Removed from the kit, the copy is in the kit archive',
    view: 'Show',
    viewText: 'Kit',
    viewGlobal: 'Global',
    viewDiff: 'Difference',
    globalLabel: 'Text in the global layer (read only)',
    diffLabel: 'Difference: global → kit',
    noDiff: 'The texts match.',
    diffTooBig: 'The text is too large for a line diff.',
    loading: 'Reading the file…',
  },
  improveReady: 'The improvement task is in the new chat input',
};
