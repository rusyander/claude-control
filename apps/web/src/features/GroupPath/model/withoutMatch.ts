import type { PathStepProposal } from '@agentdeck/contracts';

/** Предложение без найденного ресурса: человек оставил шаг своим текстом. */
export function withoutMatch(proposal: PathStepProposal): PathStepProposal {
  const next = { ...proposal };
  delete next.match;
  return next;
}
