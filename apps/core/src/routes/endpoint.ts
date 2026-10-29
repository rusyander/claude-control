import type { RouteEndpoint, RouteLease, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { Liveness, ProcessIdentity } from '../platform/process-identity.ts';

/**
 * Класс решений `endpoint` (F-73): отдать ли адрес сервера аренды. Адрес — только доказанно
 * живому серверу: личность (pid + старт) жива И порт отвечает пробе здоровья. Мёртвый процесс,
 * номер, ушедший чужому процессу (старт другой), непрочитанная таблица или молчащий порт — отказ:
 * запросы задачи ушли бы чужому слушателю того же порта или в пустоту. Единственный судья класса.
 */

/** Ответ порта: прочитан (ответил / ответил не тем) или не прочитан (ошибка, таймаут — unknown). */
export type EndpointHealth = 'answers' | 'wrong' | { unknown: string };

export type EndpointDecision =
  { kind: 'serve'; reasons: string[] } | { kind: 'refuse'; reasons: string[] };

export interface EndpointInput {
  /** Что за сервер — для причин. */
  server: string;
  /** `absent` — у аренды нет записанного сервера (не поднимался или запись не та). */
  liveness: Liveness | 'absent';
  /** Проба — только у живого по личности; нет — не пробовалась. */
  health?: EndpointHealth;
}

export function decideEndpoint(input: EndpointInput): EndpointDecision {
  const { server, liveness, health } = input;
  if (liveness === 'absent')
    return { kind: 'refuse', reasons: [`${server}: no running server recorded for the lease`] };
  if (liveness === 'dead')
    return {
      kind: 'refuse',
      reasons: [`${server}: dead by identity (exited, or its pid now belongs to another process)`],
    };
  if (liveness === 'unknown')
    return { kind: 'refuse', reasons: [`${server}: liveness unknown, identity not provable`] };
  if (health === 'answers') return { kind: 'serve', reasons: [`${server}: alive, port answers`] };
  if (health === 'wrong')
    return { kind: 'refuse', reasons: [`${server}: port answers as another server`] };
  return {
    kind: 'refuse',
    reasons: [`${server}: port health unread: ${health ? health.unknown : 'not probed'}`],
  };
}

export interface LiveEndpointArgs {
  lease: RouteLease;
  /** Подпись сервера для причин (`pid P start S <origin>`). */
  server: string;
  /** Сервер аренды и его адрес; нет — сервера у аренды нет: отказ с фактом `absent`. */
  target?: { identity: ProcessIdentity; endpoint: RouteEndpoint };
  /** Живость по снимку, начатому после вопроса (`fresh`): «жив» из кэша такта адреса не даёт. */
  isAlive: (identity: ProcessIdentity, question: { fresh: true }) => Promise<Liveness>;
  health: () => Promise<EndpointHealth>;
  record: RouteRecorder;
}

/** Прочитать факты, спросить судью; отказ — решение в журнал и `null`, никогда адрес. */
export async function liveEndpoint(args: LiveEndpointArgs): Promise<RouteEndpoint | null> {
  const { target } = args;
  const liveness: Liveness | 'absent' = target
    ? await args.isAlive(target.identity, { fresh: true }).catch((): Liveness => 'unknown')
    : 'absent';
  const health =
    liveness === 'alive'
      ? await args.health().catch((error: unknown) => ({ unknown: String(error) }))
      : undefined;
  const decision = decideEndpoint({ server: args.server, liveness, ...(health ? { health } : {}) });
  if (decision.kind === 'serve' && target) return target.endpoint;
  await args.record.decision({
    class: 'endpoint',
    facts: [
      { readClass: 'process.alive', kind: factKindOf(liveness) },
      ...(health === undefined
        ? []
        : [
            {
              readClass: 'route.availability',
              kind: typeof health === 'object' ? ('unknown' as const) : ('value' as const),
            },
          ]),
    ],
    numbers: target ? { pid: target.identity.pid } : {},
    reasons: [...decision.reasons, `lease ${args.lease.leaseId}: no endpoint given`],
    output: decision,
  });
  return null;
}

function factKindOf(liveness: Liveness | 'absent'): 'value' | 'absent' | 'unknown' {
  if (liveness === 'absent') return 'absent';
  return liveness === 'unknown' ? 'unknown' : 'value';
}
