import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import { routeCovers } from '../../policy/resolve/resolve.ts';
import type { AllowedRoute } from '../../policy/resolve/resolve.types.ts';
import { gatewayRouteId } from '../../routes/gateway/gateway.ts';
import type { ApplyCommand, SetRoutePorts } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Смена разрешённых маршрутов живой командой человека — уровень 2 (06 §Precedence, P118). Это
 * ЕДИНСТВЕННАЯ дорога расширить набор: слои 3–5 только сужают (`policy/resolve`). Команда судит:
 * каждый маршрут есть в реестре и того вида, что назван; обязательный контур (уровень 1) не
 * обходится и командой — тройка мимо его шлюза отвергается с именем, шлюз лежит — отказ.
 *
 * Прошедший суд набор ложится строкой `routes.set` (с названным расширением), и свёртка читает
 * его (`allowedRoutesOf`) вместо набора `task.created`.
 */

export type SetRouteDecision =
  | { ok: true; allowedRoutes: AllowedRoute[]; widened: AllowedRoute[]; narrowed: AllowedRoute[] }
  | {
      ok: false;
      code: 'outside-allowed-set' | 'route_unavailable' | 'unknown-route';
      reasons: string[];
    };

const label = (r: AllowedRoute): string => `${r.adapter}/${r.route.id}/${r.modelPattern}`;

/**
 * Суд нового набора против текущего. Расширение здесь разрешено (уровень 2) и НАЗВАНО
 * (`widened`) — экран и журнал видят, что набор стал шире, а не узнают об этом по факту.
 */
export function decideSetRoute(
  current: readonly AllowedRoute[],
  wanted: readonly AllowedRoute[],
  ports: SetRoutePorts,
): SetRouteDecision {
  const unknown: string[] = [];
  for (const triple of wanted) {
    const route = ports.routeOf(triple.route.id);
    if (!route) unknown.push(`${label(triple)}: ${triple.route.id} is not in the route registry`);
    else if (route.kind !== triple.route.kind)
      unknown.push(
        `${label(triple)}: registry kind ${route.kind}, command names ${triple.route.kind}`,
      );
  }
  if (unknown.length > 0) return { ok: false, code: 'unknown-route', reasons: unknown };
  const contour = ports.contour;
  if (contour?.mode === 'required') {
    const gatewayId = gatewayRouteId(contour.contourId);
    if (contour.gateway === 'down')
      return {
        ok: false,
        code: 'route_unavailable',
        reasons: [`contour ${contour.contourId} is required and its gateway is down`],
      };
    const past = wanted.filter((t) => t.route.kind !== 'gateway' || t.route.id !== gatewayId);
    if (past.length > 0)
      return {
        ok: false,
        code: 'outside-allowed-set',
        reasons: past.map(
          (t) =>
            `${label(t)}: contour ${contour.contourId} is required, only ${gatewayId} is allowed`,
        ),
      };
  }
  return {
    ok: true,
    allowedRoutes: [...wanted],
    widened: wanted.filter((w) => !current.some((have) => routeCovers(have, w))),
    narrowed: current.filter((have) => !wanted.some((w) => routeCovers(w, have))),
  };
}

export const applySetRoute: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['set-route']>;
  const { state } = task;
  if (!state.created || state.ended)
    return reject(
      task,
      command.cmdId,
      'state-conflict',
      state.ended ? `task already ended (${state.ended})` : 'task is not created yet',
    );
  // Набор маршрутов в журнале — свойство задачи; набора единицы или шага свёртка не знает.
  if (f.scope !== 'task' || f.scopeId !== state.taskId)
    return reject(
      task,
      command.cmdId,
      'unknown-scope',
      `set-route applies to the task scope only (${f.scope}:${f.scopeId})`,
    );
  const ports = env.routes?.();
  if (!ports)
    return reject(
      task,
      command.cmdId,
      'routes-unwired',
      'the conductor has no route registry wired',
    );
  const decision = decideSetRoute(allowedRoutesOf(state), f.allowedRoutes, ports);
  if (!decision.ok) return reject(task, command.cmdId, decision.code, decision.reasons.join('; '));
  task.append({
    kind: 'routes.set',
    actor: 'core',
    cmdId: command.cmdId,
    data: {
      cmdId: command.cmdId,
      allowedRoutes: decision.allowedRoutes,
      widened: decision.widened,
    },
  });
  const list = (rs: AllowedRoute[]): string => rs.map(label).join(', ') || 'none';
  return applied(task, command.cmdId, {
    scope: `task:${state.taskId}`,
    allowed: list(decision.allowedRoutes),
    widened: list(decision.widened),
    narrowed: list(decision.narrowed),
  });
};
