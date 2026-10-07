// Module of the prompt dispatcher: persist what the user actually typed, so guards can honour an
// explicit override ("re-read it", "run the tests") for the whole turn.
//
// Why a file instead of reading the transcript: guards only parse a bounded tail (~400 records)
// for cost reasons, and one long turn easily exceeds that. Measured live: after ~200 tool calls
// the user's own message had scrolled out of the window, so every "the user asked for it"
// override silently stopped working — the guard kept refusing something the user had explicitly
// requested. A 200-byte file per session removes the window from the equation entirely.
//
// The transcript stays the source of truth for HISTORY; this file only answers "what did the
// user say this turn". If it is missing or stale, guards fall back to the transcript scan.
// The dispatcher hands over prompt:'' for synthetic turns (task notifications, compaction
// continuations), so the store keeps the last thing the user actually TYPED — otherwise any phrase
// inside a notification becomes a standing "user asked for it" override for every guard.
// Contract: (input, prompt) → null, always — the write is the effect.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, sessionKey, logSessionEvent, sweepState } from '../kit-paths.mjs';

export default function recordPrompt(input, prompt) {
  try {
    const session = sessionKey(input);
    if (!prompt || !session) return null;

    const dir = stateDir('prompts');
    if (!dir) return null;
    // Cap the stored text: guards only pattern-match intent phrases, they never need an essay.
    writeFileSync(
      join(dir, `${session}.json`),
      JSON.stringify({ ts: Date.now(), prompt: prompt.slice(0, 4000) }),
      'utf8',
    );

    // The consent gate's door B on CLIs whose transcript the kit cannot read (kit-paths.mjs).
    logSessionEvent(input, { kind: 'prompt', text: prompt.slice(0, 600) });
    // Keep the folders from growing forever — one pass, oldest-first, nothing fancy.
    sweepState('prompts');
    sweepState('sessions');
  } catch {
    /* never block a user prompt */
  }
  return null;
}
