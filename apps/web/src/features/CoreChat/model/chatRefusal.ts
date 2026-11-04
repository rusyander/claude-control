import { REFUSAL_CODES, type RefusalCode } from '@agentdeck/contracts/core/routes';
import { kitCarryRefusalOf, type KitCarryRefusal } from '@agentdeck/contracts/core/session-carry';
import type { SessionView } from '@agentdeck/contracts/core/task-view';
import type { SseEvent } from '@entities/CoreTask';

/**
 * Отказ запуска CLI чата (этап 10, F2, проход 2): суд совместимости ядра отказал сеансу по коду из
 * закрытого списка (`no_core_hook` — у CLI нет хука ядра, `adapter_not_built` — переходник ещё
 * заготовка, …). Код читается из строки `decision` класса `compat` журнала задачи — её `output`
 * структурный (`{kind:'refused', code}`), прозу причины экран не разбирает. Чат с отказом не
 * откатывается на прежний исполнитель панели: экран называет отказ, и всё.
 */

export interface LaunchRefusal {
  /** Номер строки журнала: отказ, после которого сеанс всё же начался, уже не действует. */
  seq: number;
  code: RefusalCode;
  /** Настройка, из-за которой отказ (`bypass_setting`), — как её назвало ядро. */
  setting: string | null;
}

const isCode = (v: unknown): v is RefusalCode =>
  typeof v === 'string' && (REFUSAL_CODES as readonly string[]).includes(v);

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Отказ суда совместимости из кадра ленты задачи; иной кадр — `null`. */
export function launchRefusalOfEvent(event: SseEvent): LaunchRefusal | null {
  let line: Record<string, unknown> | null;
  try {
    line = record(JSON.parse(event.data));
  } catch {
    return null;
  }
  if (!line || line.kind !== 'decision' || typeof line.seq !== 'number') return null;
  const data = record(line.data);
  const output = record(data?.output);
  if (data?.class !== 'compat' || output?.kind !== 'refused' || !isCode(output.code)) return null;
  return {
    seq: line.seq,
    code: output.code,
    setting: typeof output.setting === 'string' ? output.setting : null,
  };
}

/** Последний отказ действует, пока после него не начался ни один сеанс чата. */
export function activeLaunchRefusal(
  refusal: LaunchRefusal | null,
  sessions: readonly SessionView[],
): LaunchRefusal | null {
  if (!refusal) return null;
  return sessions.some((s) => s.startedSeq > refusal.seq) ? null : refusal;
}

/** Коды со своим объяснением на экране; прочие — общая строка с кодом. */
export const EXPLAINED_REFUSALS = ['no_core_hook', 'adapter_not_built'] as const;
export type ExplainedRefusal = (typeof EXPLAINED_REFUSALS)[number];

export function explainedRefusal(code: RefusalCode): ExplainedRefusal | 'other' {
  return (EXPLAINED_REFUSALS as readonly string[]).includes(code)
    ? (code as ExplainedRefusal)
    : 'other';
}

/**
 * Строка отказа на экране: ключ текста и его подстановки. Отказ суда — по коду; шаг, кончившийся
 * неудачей без единого сеанса, — причиной ядра дословно, кроме отказа переноса набора панели (G13):
 * он называет причину и выход своим текстом (`kitHooks`/`kitMcp`/`kitMissing`; локальный слой
 * проекта и CLI без поля переноса — G14 p7); иначе строки нет.
 */
const KIT_KEY = {
  hooks: 'kitHooks',
  mcp: 'kitMcp',
  missing: 'kitMissing',
  layerUntrusted: 'layerUntrusted',
  layerMode: 'layerMode',
  layerSources: 'layerSources',
  layerBuild: 'layerBuild',
  layerFit: 'layerFit',
  unsupported: 'carryUnsupported',
} as const satisfies Record<KitCarryRefusal['kind'], string>;

export type CarryRefusalKey = (typeof KIT_KEY)[KitCarryRefusal['kind']];
export type RefusalLineKey = ExplainedRefusal | 'other' | 'failed' | CarryRefusalKey;

/** Отказ переноса слоя словами ядра или панели → ключ текста и подстановки; иное — `null`. */
export function carryRefusalLine(
  reason: string,
): { key: CarryRefusalKey; params: Record<string, string> } | null {
  const kit = kitCarryRefusalOf(reason);
  if (!kit) return null;
  const { kind, ...params } = kit;
  return { key: KIT_KEY[kind], params };
}

export function refusalLine(
  refusal: LaunchRefusal | null,
  failedReason: string | null,
): { key: RefusalLineKey; params: Record<string, string> } | null {
  if (refusal) {
    return {
      key: explainedRefusal(refusal.code),
      params: { code: refusal.code, setting: refusal.setting ?? '' },
    };
  }
  if (failedReason === null) return null;
  return carryRefusalLine(failedReason) ?? { key: 'failed', params: { reason: failedReason } };
}
