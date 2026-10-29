import type { LayerMode, LayerRun, SessionSpec } from '../adapter.types.ts';

/**
 * Слой сеанса на деле (03 §Layer control, F-86). Доверие — отметка ИСХОДНОГО репозитория:
 * отметка панели или запись доверия самого CLI к этой папке; нет отметки, нет пути источника или
 * запись не прочлась — копия недоверенная, слой репозитория до сеанса не доходит. Где записи
 * CLI и как он сравнивает пути — знает переходник (`readCliMark`), здесь только порядок.
 */

/** Запись доверия CLI к папке: прочитана (есть отметка или нет) или неизвестна (F25). */
export type CliTrustRead = { trusted: boolean; detail?: string } | { unknown: string };

export interface LayerPolicy {
  /** Читает запись доверия CLI к исходному репозиторию (окружение — пин задачи). */
  readCliMark(sourceRepo: string, pin: Record<string, string>): Promise<CliTrustRead>;
  /** Режим недоверенной копии по запрошенному: Claude `on` → `observe`, Qwen — как есть. */
  untrusted(asked: LayerMode): LayerMode;
}

/** Слой «как просили» с доверенным репозиторием — для планов и отказов вне запуска (проверки). */
export function trustedLayer(spec: SessionSpec): LayerRun {
  return { asked: spec.layer.hooks, ran: spec.layer.hooks, repoLayer: true, trust: 'panel' };
}

export async function resolveLayer(spec: SessionSpec, policy: LayerPolicy): Promise<LayerRun> {
  const asked = spec.layer.hooks;
  const trusted = (trust: 'panel' | 'cli'): LayerRun => ({
    asked,
    ran: asked,
    repoLayer: true,
    trust,
  });
  const untrusted = (trust: 'none' | 'unknown', detail: string): LayerRun => ({
    asked,
    ran: policy.untrusted(asked),
    repoLayer: false,
    trust,
    detail,
  });
  if (!spec.trust) return untrusted('none', 'the launch names no source repo');
  if (spec.trust.panelMark) return trusted('panel');
  const read = await policy.readCliMark(spec.trust.sourceRepo, spec.env.pin);
  if ('unknown' in read) return untrusted('unknown', read.unknown);
  if (read.trusted) return trusted('cli');
  return untrusted(
    'none',
    read.detail ?? `no trust mark for the source repo ${spec.trust.sourceRepo}`,
  );
}
