import type { CheckDecision } from '@agentdeck/contracts/core/records';
import { flagLike, why } from './helpers.ts';
import type { Gathered } from './request.types.ts';

/** argv вне реестра на дороге, где гонит ядро: отказ с именем, ничего не запускается. */
export function notRegistered(g: Gathered): Extract<CheckDecision, { kind: 'refuse' }> {
  if (!('value' in g.registry))
    return {
      kind: 'refuse',
      unmet: [
        {
          code: 'registry-unreadable',
          subject: why(g.registry),
          next: 'fix the profile read, then ask again',
        },
      ],
      next: 'ask again once the registry reads',
    };
  const argv = g.match.kind === 'absent' ? [] : g.match.entry.argv;
  return {
    kind: 'refuse',
    unmet: [
      {
        code: 'not-registered',
        subject: `argv «${argv.join(' ').slice(0, 200)}» matches no registry check`,
        next: 'call check by checkId (one of the registry checks), or add the command to .agentdeck/checks.json',
      },
    ],
    next: 'name a registry check by checkId',
  };
}

export function unsafeSelection(
  selection: readonly string[],
): Extract<CheckDecision, { kind: 'refuse' }> {
  const bad = selection.filter(flagLike);
  return {
    kind: 'refuse',
    unmet: [
      {
        code: 'selection-unsafe',
        subject: `test names read as runner flags: ${bad.join(', ').slice(0, 300)}`,
        next: 'name tests by their full name without a leading dash',
      },
    ],
    next: 'ask again without the dash-led names',
  };
}
