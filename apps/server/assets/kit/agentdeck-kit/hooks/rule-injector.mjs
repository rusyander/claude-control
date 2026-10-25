#!/usr/bin/env node
// Delivers a situational rule (git writes, published text, verification depth, review, docker, PDF…) once, at the moment it applies.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import ruleInjector, { cardGate, clearRuleStamps, MAX_RULE_CEILING } from './lib/rule-injector.mjs';
export { MAX_RULE_CEILING };
import { runIfMain } from './lib/items.mjs';

export const hooks = {
  // Text, or a deny while a card this call triggers is unread — the card still rides in `context`.
  rules: (input) => {
    const text = ruleInjector(input);
    const reason = cardGate(input);
    return reason ? { decision: 'deny', reason, context: text } : text;
  },
  precompact: (input) => void clearRuleStamps(input?.session_id),
};

await runIfMain(import.meta.url, 'rule-injector', { hooks, MAX_RULE_CEILING });
