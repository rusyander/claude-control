import type { PathAnchor, PathLang, PathStep, PathStepProposal } from '@agentdeck/contracts';

/**
 * Шаг из предложения ассистента. Правка существующего шага сохраняет его id,
 * место и дату; новый получает id и дату здесь — сервер их не выдаёт, а шаг
 * уходит в PUT целиком.
 */
export function stepFromProposal(
  proposal: PathStepProposal,
  options: {
    anchor: PathAnchor;
    lang: PathLang;
    existing?: PathStep;
    makeId: () => string;
    now: string;
  },
): PathStep {
  const { existing } = options;
  const gate = proposal.gate && (proposal.gate.ru || proposal.gate.en) ? proposal.gate : undefined;
  return {
    id: existing?.id ?? options.makeId(),
    anchor: existing?.anchor ?? options.anchor,
    order: existing?.order ?? 0,
    // Ассистент нашёл готовый ресурс, который делает ровно это, — шаг сразу
    // ссылается на него, а не повторяет его текстом.
    kind: proposal.match ? 'resource' : (existing?.kind ?? 'prompt'),
    title: proposal.title,
    prompt: proposal.prompt,
    source: options.lang,
    ...resourceOf(proposal, existing),
    ...(gate ? { gate } : {}),
    createdAt: existing?.createdAt ?? options.now,
  };
}

function resourceOf(proposal: PathStepProposal, existing: PathStep | undefined): Partial<PathStep> {
  if (proposal.match) return { resource: { type: proposal.match.type, id: proposal.match.id } };
  if (existing?.resource) return { resource: existing.resource };
  return {};
}
