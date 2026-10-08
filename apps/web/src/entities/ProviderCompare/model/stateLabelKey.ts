import type { CompareState } from '@agentdeck/contracts';

/** Ключ подписи состояния — стороны называются по именам провайдеров в самой разметке. */
export function stateLabelKey(state: CompareState): string {
  return `providerCompare.state.${state}`;
}
