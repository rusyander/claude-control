import type { ComposeService } from '@entities/Compose';

export type ServiceTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface ServiceStateView {
  tone: ServiceTone;
  /** Ключ в `environment.state`. */
  key:
    | 'running'
    | 'healthy'
    | 'starting'
    | 'unhealthy'
    | 'stopped'
    | 'crashed'
    | 'created'
    | 'restarting'
    | 'paused'
    | 'dead'
    | 'absent';
  /** Идёт переход — точка пульсирует. */
  pulse: boolean;
  code?: number;
}

/**
 * Коды, с которыми контейнер выходит, когда его ОСТАНОВИЛИ: 0 — сам закончил,
 * 137 — SIGKILL (docker stop не дождался), 143 — SIGTERM. Это не падение:
 * «Упал, код 137» после «Остановить» напугал бы зря.
 */
const STOP_CODES = new Set([0, 137, 143]);

export function serviceStateView(service: ComposeService): ServiceStateView {
  switch (service.state) {
    case 'running':
      if (service.health === 'healthy') return { tone: 'success', key: 'healthy', pulse: false };
      if (service.health === 'starting') return { tone: 'warning', key: 'starting', pulse: true };
      if (service.health === 'unhealthy') return { tone: 'danger', key: 'unhealthy', pulse: false };
      return { tone: 'success', key: 'running', pulse: false };
    case 'exited':
      if (service.exitCode === undefined || STOP_CODES.has(service.exitCode)) {
        return { tone: 'neutral', key: 'stopped', pulse: false };
      }
      return { tone: 'danger', key: 'crashed', pulse: false, code: service.exitCode };
    case 'restarting':
      return { tone: 'warning', key: 'restarting', pulse: true };
    case 'dead':
      return { tone: 'danger', key: 'dead', pulse: false };
    case 'created':
    case 'paused':
    case 'absent':
      return { tone: 'neutral', key: service.state, pulse: false };
  }
}

/** Сервис занят делом — «Поднять» ему не нужно, нужны «Остановить» и «Перезапустить». */
export const isServiceUp = (service: ComposeService): boolean =>
  service.state === 'running' || service.state === 'restarting';
