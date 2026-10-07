// Hook dispatcher core. One node process runs N checks instead of N processes.
// Why: on Windows a node cold start is ~80-150 ms; four hooks on every Write/Edit added ~0.5 s
// per edit for nothing. Modules are plain functions over the already-parsed hook input.
// A module that throws is skipped - one broken check must never disable the others.
import { stdin } from 'node:process';

// A BOM or stray whitespace on stdin must not kill a guard: JSON.parse would throw, the hook
// would fall through to "allow", and the check would be silently dead. Strip both first.
export async function readInput() {
  let raw = '';
  try {
    for await (const chunk of stdin) raw += chunk;
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch {
    return null;
  }
}

/**
 * PreToolUse: modules return null | {decision:'deny'|'ask', reason}.
 * First 'deny' wins; otherwise the first 'ask'. Silence = allow (no output at all).
 */
export function runPre(input, modules) {
  let ask = null;
  for (const mod of modules) {
    let verdict;
    try {
      verdict = mod(input);
    } catch {
      continue;
    }
    if (!verdict) continue;
    if (verdict.decision === 'deny') return verdict;
    if (!ask) ask = verdict;
  }
  return ask;
}

// Every byte a hook prints is re-billed on every later turn of the session (it lands in the
// transcript as an attachment, inside the cached prefix). Measured: hook payload averaged
// ~1.8k tokens per session before this cap. A verdict that cannot make its case in CAP chars
// has to point at a doc instead of quoting it.
export const CAP = { pre: 1200, post: 700 };

export function cap(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 20)}… [truncated ${s.length - max + 20}]`;
}

/** `context` rides beside the verdict for the model (the reason of an `ask` is shown to the user). */
export function emitPre(verdict, context = null) {
  if (!verdict) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: cap(verdict.reason, CAP.pre),
        ...(context ? { additionalContext: cap(context, CAP.pre) } : {}),
      },
    }),
  );
}

/**
 * PreToolUse, non-blocking: inject text into context without touching the permission verdict.
 * Separate from emitPre because this is a DELIBERATE payload (a situational rule delivered at its
 * trigger), not a guard explaining itself — so it carries its own, larger ceiling.
 */
export function emitPreContext(text, max = 2400) {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: cap(text, max) },
    }),
  );
}

/** PostToolUse: modules return null | string; all messages are joined into one context block. */
export function runPost(input, modules) {
  const out = [];
  for (const mod of modules) {
    try {
      const msg = mod(input);
      if (msg) out.push(msg);
    } catch {
      /* skip */
    }
  }
  return out.length ? out.join('\n\n') : null;
}

export function emitPost(text) {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: cap(text, CAP.post) },
    }),
  );
}
