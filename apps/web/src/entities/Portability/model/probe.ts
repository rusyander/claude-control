import {
  probeLayers,
  type ProbeObservation,
  type ProbeVerdict,
} from '@agentdeck/contracts/portable-probe';
import type { ProbeLayer } from '@agentdeck/contracts/portable-probe';
import type { BadgeTone } from '@shared/ui/badge';

/**
 * Показ приёмочной пробы (П2.4). Словари ЗАКРЫТЫ по типу — как у верности:
 * добавленный в канон слой или приговор не соберётся, пока ему не назначили тон
 * и перевод, иначе он приехал бы на экран серой меткой со своим кодом.
 */

/**
 * Цвет приговора. `not_checked` — НЕ серый и не зелёный: «не проверено» ближе к
 * предупреждению, потому что человек, увидевший нейтральную метку, читает её как
 * «всё в порядке», а это ровно та ложь, ради запрета которой проба и отказалась
 * от зелёного по умолчанию.
 */
export const VERDICT_TONE: Record<ProbeVerdict, BadgeTone> = {
  match: 'success',
  mismatch: 'danger',
  not_checked: 'warning',
};

/**
 * Цвет наблюдения. Он говорит только о том, ЧТО видели, и ничего — о том, верно
 * ли это: «не доехало» на уровне «невозможно» — правильный исход, и красить его
 * красным значило бы спорить с приговором соседней метки.
 */
export const OBSERVATION_TONE: Record<ProbeObservation, BadgeTone> = {
  enforced: 'accent',
  present: 'info',
  absent: 'neutral',
  unknown: 'neutral',
};

/** Порядок строк отчёта — тот же, что в каноне: у отчёта один порядок везде. */
export const PROBE_LAYER_ORDER: readonly ProbeLayer[] = probeLayers;

export function probeLayerLabelKey(layer: ProbeLayer): string {
  return `portability.probe.layer.${layer}`;
}

export function probeObservationLabelKey(observation: ProbeObservation): string {
  return `portability.probe.observation.${observation}`;
}

export function probeVerdictLabelKey(verdict: ProbeVerdict): string {
  return `portability.probe.verdict.${verdict}`;
}

/** Причина пропуска. Без перевода показывает свой код, а не пустоту. */
export function probeSkipLabelKey(skip: string): string {
  return `portability.probe.skip.${skip}`;
}
