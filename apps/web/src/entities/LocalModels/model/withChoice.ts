import type { LocalChoiceBody, LocalModelsInfo } from '@agentdeck/contracts/local-models';

/**
 * Снимок с уже применённым выбором: страница перерисовывает строку, не дожидаясь
 * сервера. Неназванное остаётся прежним, чужие модели не трогаются.
 */
export function withChoice(info: LocalModelsInfo, body: LocalChoiceBody): LocalModelsInfo {
  const { tag, ...next } = body;
  return { ...info, choices: { ...info.choices, [tag]: { ...info.choices[tag], ...next } } };
}
