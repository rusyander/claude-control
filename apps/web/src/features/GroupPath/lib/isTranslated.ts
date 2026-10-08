import type { PathStepProposal, PathLang } from '@agentdeck/contracts';
import { otherLang } from '../model/otherLang';

/** Перевод полон: у второй стороны есть промпт и условие, если оно есть у правленой. */
export function isTranslated(proposal: PathStepProposal, from: PathLang): boolean {
  const to = otherLang(from);
  if (!proposal.prompt[to].trim()) return false;
  const gateFrom = proposal.gate?.[from].trim();
  return !gateFrom || Boolean(proposal.gate?.[to].trim());
}
