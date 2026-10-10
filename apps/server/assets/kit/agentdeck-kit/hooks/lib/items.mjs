// Kit hook core: every guard is its own item file `hooks/<name>.mjs`, so the panel can switch each
// one off (a switched-off item is simply absent from the composed kit). One dispatcher process per
// hook event (`lib/run.mjs <event>`) imports only the items present and runs them over ONE parsed
// input — a node cold start costs ~80-150 ms on Windows, and four checks on every edit must not pay it
// four times. An item that throws is skipped: one broken check never disables the others.
//
// Item contract: `export const hooks = { <event>: spec }`, where spec is a function, or
// `{ tools: RegExp, run }` for tool events. Events:
//   pre          PreToolUse         (input) → null | {decision:'deny'|'ask', reason}
//   rules        PreToolUse, after the verdict, only when every guard stayed silent → string | null
//   post-edit    PostToolUse on Write/Edit → string | null
//   post-any     PostToolUse on any tool → string | null
//   stop         Stop               → null | {decision:'block', reason}
//   prompt       UserPromptSubmit   (input, prompt) → string | null
//   session      SessionStart       → string | null
//   precompact   PreCompact         → string | null
//   postcompact  PostCompact        → null | {systemMessage, context}
//
// Input arrives in whatever shape the calling CLI uses; `normalize` (kit-paths.mjs) turns it into
// Claude's, and a Codex `apply_patch` over N files becomes N calls judged one by one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_ROOT, cliOf, normalize } from './kit-paths.mjs';
import { CAP, cap, readInput } from './dispatch.mjs';
import recordPrompt from './prompt/record-prompt.mjs';
import { isSyntheticPrompt } from './transcript.mjs';

export const HOOKS_DIR = join(KIT_ROOT, 'hooks');

/** Run order per event. A name absent from disk (switched off in the panel) is skipped. */
export const MANIFEST = {
  pre: [
    'git-guard',
    'destructive-consent',
    'secret-guard',
    'import-weight-guard',
    'agent-doc-location',
    'review-report-guard',
    'language-guard',
    'agent-prompt-guard',
    'spawn-cost-guard',
    'local-discipline',
    'doc-size-guard',
    'read-discipline',
    'todo-throttle',
    'verify-throttle',
    'search-discipline',
    'review-publish-guard',
    'pipeline-watch-guard',
    // Last on purpose: the only item that may touch the network (one `git fetch` before a publish),
    // so every cheaper refusal — git-guard's consent above all — gets to refuse first.
    'push-sieves',
  ],
  rules: ['rule-injector'],
  'post-edit': ['format-on-edit', 'doc-bloat-guard', 'doc-daily-review'],
  'post-any': ['context-watch', 'review-publish-guard'],
  // verify-at-stop first: its block makes the model run the gate and write the summary again, and
  // that summary is what reply-language judges — the other order costs a possible third turn.
  stop: ['verify-at-stop', 'review-report-guard', 'reply-language'],
  prompt: ['figma-hint', 'verify-hard-hint', 'docs-order-hint', 'skill-hint'],
  session: [
    'context-budget',
    'project-onboard-check',
    'doc-hygiene-autoclean',
    'review-sync-brief',
  ],
  precompact: ['rule-injector', 'precompact-checkpoint'],
  postcompact: ['clear-advisor'],
};

const EVENT_NAME = {
  pre: 'PreToolUse',
  'post-edit': 'PostToolUse',
  'post-any': 'PostToolUse',
  stop: 'Stop',
  prompt: 'UserPromptSubmit',
  session: 'SessionStart',
  precompact: 'PreCompact',
  postcompact: 'PostCompact',
};

export const TOOLS = {
  BASH: /^(Bash|PowerShell)$/,
  EDIT: /^(Write|Edit|NotebookEdit)$/,
  SPAWN: /^(Agent|Task|SendMessage|Workflow)$/,
  CTX: /^(Read|Grep|Glob|TodoWrite|Bash|PowerShell)$/,
  /** A forge or tracker MCP server under any configured name, the panel's bridge included. */
  FORGE: /^mcp__[^_]*(?:gitlab|github|atlassian|jira|confluence)[^_]*__/i,
};

/** `<kit>` in any text the model reads → the real kit root, so a printed command runs as is. */
const ROOT = KIT_ROOT.split('\\').join('/');
export const withRoot = (text) =>
  String(text ?? '')
    .split('<kit>')
    .join(ROOT);

/** The item modules of one event, in manifest order; `only` restricts to one item (standalone run). */
async function itemsFor(event, only = null) {
  const out = [];
  for (const name of MANIFEST[event] ?? []) {
    if (only && name !== only.name) continue;
    let mod = only?.module ?? null;
    if (!mod) {
      const file = join(HOOKS_DIR, `${name}.mjs`);
      if (!existsSync(file)) continue;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch {
        continue;
      }
    }
    const spec = mod?.hooks?.[event];
    if (!spec) continue;
    out.push({
      name,
      tools: typeof spec === 'function' ? null : (spec.tools ?? null),
      run: typeof spec === 'function' ? spec : spec.run,
      module: mod,
    });
  }
  return out;
}

function attempt(fn, ...args) {
  try {
    return fn(...args);
  } catch {
    return null;
  }
}

const write = (obj) => process.stdout.write(JSON.stringify(obj));

/** PreToolUse: first deny wins, otherwise the first ask; silence → situational rules may ride in. */
async function runPre(input, only) {
  const calls = normalize(input);
  const items = await itemsFor('pre', only);
  let ask = null;
  let deny = null;
  for (const call of calls) {
    const tool = String(call?.tool_name ?? '');
    for (const item of items) {
      if (item.tools && !item.tools.test(tool)) continue;
      const v = attempt(item.run, call);
      if (!v) continue;
      if (v.decision === 'deny') {
        deny = v;
        break;
      }
      ask ??= v;
    }
    if (deny) break;
  }
  const sieves = items.find((i) => i.name === 'push-sieves')?.module;
  const note = sieves?.takeNote ? attempt(sieves.takeNote) : null;
  let verdict = deny ?? ask;
  // Codex has no "ask" for a hook: an ask becomes a deny whose reason tells the model to get the
  // user's yes in chat first — the consent gate then opens on that answer (kit session log).
  if (verdict?.decision === 'ask' && cliOf(input) === 'codex')
    verdict = {
      decision: 'deny',
      reason: `Needs the user's yes first — ask in chat, naming this exact call, then repeat it after they agree. ${verdict.reason}`,
    };
  if (verdict) {
    write({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: cap(withRoot(verdict.reason), CAP.pre),
        ...(verdict.decision === 'ask' && note
          ? { additionalContext: cap(withRoot(note), CAP.pre) }
          : {}),
      },
    });
    return;
  }
  if (only) return;
  // Spawns get no rules: their surface is the prompt, and agent-prompt-guard already owns it.
  const tool = String(calls[0]?.tool_name ?? '');
  let rules = null;
  let ceiling = 2400;
  if (!TOOLS.SPAWN.test(tool)) {
    for (const item of await itemsFor('rules')) {
      const texts = calls.map((c) => attempt(item.run, c)).filter(Boolean);
      if (texts.length) rules = texts.join('\n\n');
      ceiling = item.module?.MAX_RULE_CEILING ?? ceiling;
    }
  }
  const context = [note, rules].filter(Boolean).join('\n\n');
  if (context)
    write({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: cap(withRoot(context), ceiling),
      },
    });
}

async function runText(event, input, only, prompt) {
  const calls = event === 'post-edit' || event === 'post-any' ? normalize(input) : [input];
  const out = [];
  for (const item of await itemsFor(event, only))
    for (const call of calls) {
      if (item.tools && !item.tools.test(String(call?.tool_name ?? ''))) continue;
      const msg = attempt(item.run, call, prompt);
      if (msg) out.push(msg);
    }
  return out.length ? withRoot(out.join('\n\n')) : null;
}

/** Run one hook event over stdin. `only` = `{name, module}` when an item file runs standalone. */
export async function runEvent(event, input, only = null) {
  if (!input || typeof input !== 'object' || !EVENT_NAME[event]) return;
  if (event === 'pre') return runPre(input, only);

  if (event === 'stop') {
    for (const item of await itemsFor('stop', only)) {
      const v = attempt(item.run, input);
      if (v) return write({ ...v, reason: withRoot(v.reason) });
    }
    return;
  }

  if (event === 'postcompact') {
    for (const item of await itemsFor('postcompact', only)) {
      const v = attempt(item.run, input);
      if (v)
        return write({
          systemMessage: v.systemMessage,
          hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: v.context },
        });
    }
    return;
  }

  let prompt = '';
  if (event === 'prompt') {
    const raw = String(input.prompt ?? '');
    prompt = isSyntheticPrompt(raw) ? '' : raw;
    if (!prompt.trim()) return;
    // The per-session prompt store the consent gates read — infrastructure, never an item.
    attempt(recordPrompt, input, prompt);
  }

  const text = await runText(event, input, only, prompt);
  if (!text) return;
  // PreCompact output is plain text: its JSON shape is not the same on every CLI build.
  if (event === 'precompact') return void process.stdout.write(text);
  const max = event === 'post-edit' || event === 'post-any' ? CAP.post : 4000;
  write({
    hookSpecificOutput: { hookEventName: EVENT_NAME[event], additionalContext: cap(text, max) },
  });
}

/** Which kit event a CLI's hook input belongs to, for an item file run on its own. */
function eventOf(input, hooks) {
  const name = String(input?.hook_event_name ?? input?.hookEventName ?? '');
  const tool = String(normalize(input)[0]?.tool_name ?? '');
  const has = (e) => Boolean(hooks[e]);
  if (name === 'PreToolUse') return has('pre') ? 'pre' : null;
  if (name === 'PostToolUse')
    return has('post-edit') && TOOLS.EDIT.test(tool)
      ? 'post-edit'
      : has('post-any')
        ? 'post-any'
        : null;
  if (name === 'Stop') return has('stop') ? 'stop' : null;
  if (name === 'UserPromptSubmit') return has('prompt') ? 'prompt' : null;
  if (name === 'SessionStart') return has('session') ? 'session' : null;
  if (name === 'PreCompact') return has('precompact') ? 'precompact' : null;
  if (name === 'PostCompact') return has('postcompact') ? 'postcompact' : null;
  // No event name on stdin: an item with exactly one event can still be run by hand.
  const own = Object.keys(hooks).filter((e) => e !== 'rules');
  return own.length === 1 ? own[0] : null;
}

/**
 * Called at the bottom of every item file: when THAT file is the process entry point (wired directly
 * in a CLI's hook config, or run by hand), read stdin and run just this item.
 */
export async function runIfMain(url, name, module) {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
  if (entry.toLowerCase() !== String(url).toLowerCase()) return;
  const input = await readInput();
  const event = input ? eventOf(input, module.hooks ?? {}) : null;
  if (event) await runEvent(event, input, { name, module });
  process.exit(0);
}
