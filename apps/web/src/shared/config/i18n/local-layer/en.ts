import type { localLayerRu } from './ru.ts';

/** English texts of the «Local layer» card; typed against the Russian module. */
export const localLayerEn: typeof localLayerRu = {
  title: 'Local layer',
  intro:
    "The project's team layer — CLAUDE.md, .claude/rules, hooks and permissions from .claude/settings.json, skills, .mcp.json servers — assembled as a copy in .agent/local-layer/. Panel chats load it instead of the team files themselves: you can work on compressed instructions or on faster hooks from a not-yet-merged MR without touching the repository. A compressed piece is used only while it was made from the current text, a hook replacement only while the team file is the one it improves; otherwise the team version goes.",
  state: {
    used: 'in use',
    'no-config': 'not set up',
    off: 'off',
    'no-gain': 'not needed',
    broken: 'build failed',
  },
  reason: {
    'no-config':
      'The project has no .agent/local-layer/layer.json — chats run on the team layer as is.',
    off: 'The layer is off — chats run on the team layer.',
    on: 'Always on — chats run on the layer.',
    gain: 'Auto mode: the layer has something to offer, chats run on it.',
    'no-gain':
      'Auto mode: the layer has nothing to offer — no active hook replacement, and compression saves under 500 characters. Chats run on the team layer.',
    broken: 'The layer failed to build — chats run on the team layer.',
  },
  create: 'Create layer',
  createHint:
    'Creates layer.json in auto mode: the layer is used as soon as it has something to offer.',
  modeLabel: 'Mode',
  mode: {
    auto: 'Auto — only when it pays off',
    on: 'Always',
    off: 'Off',
  },
  instructions: 'Instructions: {{files}} files, {{team}} → {{layer}} characters',
  excluded:
    'Removed by your claudeMdExcludes: {{count}} — absent from both the team layer and the local one',
  compressed: 'Compressed sections: {{compressed}} of {{sections}}',
  pending: 'Awaiting re-compression — the team text changed, sent verbatim for now: {{list}}',
  pathRules:
    'Path rules and nested CLAUDE.md files: {{count}} — delivered on the first touch of a matching file',
  skills: 'Skills: {{list}}',
  mcp: 'MCP servers: {{list}}',
  hooks: 'Team hooks: {{count}}',
  none: 'none',
  overrides: 'Hook replacements',
  overrideState: {
    active: 'active',
    retired: 'MR merged — replacement no longer needed',
    stale: 'the team changed the file — replacement dropped',
    unrelocatable: 'the copy cannot be relocated — replacement dropped',
    'missing-ref': 'commit not found — replacement dropped',
  },
  orphans: 'Compressed files with no team original, unused: {{list}}',
  loadError: 'Could not read the local layer',
};
