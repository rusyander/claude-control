#!/usr/bin/env node
// Delivers a situational rule (git writes, published text, verification depth, review, docker, PDF…) once, at the moment it applies.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import ruleInjector, {
  cardGate,
  clearRuleStamps,
  compactCards,
  markCompaction,
  MAX_RULE_CEILING,
  PRESEND_MAX,
} from './lib/rule-injector.mjs';
export { MAX_RULE_CEILING };
import { runIfMain } from './lib/items.mjs';

export const hooks = {
  // Text, or a deny while a card this call triggers is unread — the card still rides in `context`.
  rules: (input) => {
    const text = ruleInjector(input);
    const reason = cardGate(input);
    return reason ? { decision: 'deny', reason, context: text } : text;
  },
  // A non-Claude CLI also gets a `compact` marker in the kit session log: the generation boundary
  // compactCards cuts at, its transcript having none the kit can read (P-29).
  precompact: (input) => {
    clearRuleStamps(input?.session_id);
    markCompaction(input);
  },
  // SessionStart:compact in a split child: the cards the ended generation needed, gates armed.
  // `kit_room` = what the earlier SessionStart items left of the block's cap (items.mjs).
  session: (input) =>
    compactCards(input, Math.min(PRESEND_MAX, Number(input?.kit_room) || PRESEND_MAX)),
};

await runIfMain(import.meta.url, 'rule-injector', { hooks, MAX_RULE_CEILING });
