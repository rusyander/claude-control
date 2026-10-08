import type { PathStepProposal, PathLang } from '@agentdeck/contracts';

/**
 * Ответ переводчика поверх шага из окна: берётся только вторая сторона.
 * Пустое название в ответе оставляет прежнее (название — подпись, не
 * инструкция); промпт и условие готовности берутся ТОЛЬКО из ответа — старый
 * текст второй стороны и есть то, от чего перевод спасает.
 */
export function mergeTranslation(
  current: PathStepProposal,
  answer: PathStepProposal,
  to: PathLang,
): PathStepProposal {
  return {
    ...current,
    title: { ...current.title, [to]: answer.title[to] || current.title[to] },
    prompt: { ...current.prompt, [to]: answer.prompt[to] ?? '' },
    ...(current.gate ? { gate: { ...current.gate, [to]: answer.gate?.[to] ?? '' } } : {}),
  };
}
