import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { RouteLease, RouteResource } from '@agentdeck/contracts/core/routes';
import type { DenySet } from '../../adapters/adapter.types.ts';
import { unitCopyOf } from '../../conductor/copy/index.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { SESSION_OS_ENV_NAMES } from '../../platform/base-env.ts';
import { LEASE_SIGNAL } from '../session-road/lease-release.ts';
import type { RoadStart } from '../session-road.ts';
import type { RoadResume } from '../session-road/road.types.ts';
import { conversationOf } from '../economy-wiring/continuation.ts';

/**
 * Запуск сессии шага в продукте (зона B): из чего дорога сессии ядра собирает CLI. Копия — та, что
 * разложил крючок копии (F, `unitCopyOf`), маршрут и модель — суд `tier` шага (A, `s.routing`),
 * аренда — живая из журнала после перезапуска ядра, иначе дорога берёт её у реестра маршрутов.
 */

/** Запреты шага поверх платформы: публикация, `.git`, дом ядра — запреты платформы, их кладёт дорога. */
export const STEP_DENY: DenySet = { paths: [], commands: [], mcpTools: [], tools: [] };

/** Каталог сессии — рядом с журналом задачи: его находит и следующее ядро (прикрепление, P89). */
export const sessionDirOf = (task: LiveTask, sessionId: string): string =>
  join(task.dir, 'sessions', sessionId);

/**
 * Каталог сессии, как его назвал журнал: цель `process-start` — каталог сессии (03 §Launcher).
 * Журнал старше этого правила — по тому же правилу `sessionDirOf`.
 */
export function journaledSessionDir(task: LiveTask, sessionId: string): string {
  for (const action of Object.values(task.state.actions)) {
    if (action.kind !== 'process-start') continue;
    if (action.target.split(/[\\/]/).pop() === sessionId) return action.target;
  }
  return sessionDirOf(task, sessionId);
}

/**
 * Окружение, которое ядро передаёт CLI (пин задачи): переменные, по которым CLI находит дом, вход и
 * свои настройки, — того человека, что запустил ядро. Остальное окружение ядра CLI не нужно.
 */
const PIN_KEYS = [...SESSION_OS_ENV_NAMES, 'CLAUDE_CONFIG_DIR'];

export function processPin(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pin: Record<string, string> = {};
  for (const key of PIN_KEYS) {
    const value = env[key];
    if (value !== undefined) pin[key] = value;
  }
  return pin;
}

/**
 * Аренда маршрута, пережившая прежнее ядро: строка `route-lease` того же маршрута и модели, все
 * её ресурсы ещё живы. Аренда без ресурсов (вход CLI) не переиспользуется — новая ничего не стоит.
 */
export function journaledLease(
  task: LiveTask,
  routeId: string,
  model: string | null,
): RouteLease | undefined {
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const created = new Map<string, RouteResource>();
  let found: RouteLease | undefined;
  for (const line of lines) {
    if (line.kind === 'resource.created') {
      const d = (line as JournalLine<'resource.created'>).data;
      created.set(d.rid, { rid: d.rid, kind: d.kind, ref: d.ref, release: d.release });
      continue;
    }
    if (line.kind !== 'signal') continue;
    const d = (line as JournalLine<'signal'>).data;
    if (d.signal !== LEASE_SIGNAL) continue;
    let detail: { routeId?: unknown; model?: unknown; rids?: unknown };
    try {
      detail = JSON.parse(d.detail) as typeof detail;
    } catch {
      continue;
    }
    if (detail.routeId !== routeId || detail.model !== model || !Array.isArray(detail.rids))
      continue;
    const rids = detail.rids.filter((r): r is string => typeof r === 'string');
    if (rids.length === 0) continue;
    if (!rids.every((rid) => task.state.resources[rid]?.status === 'live')) continue;
    const resources = rids.map((rid) => created.get(rid));
    if (resources.some((r) => r === undefined)) continue;
    // Последняя живая — та, что держала последняя сессия этого маршрута.
    found = { leaseId: d.subject, routeId, model, resources: resources as RouteResource[] };
  }
  return found;
}

/** Системная часть брифа: шаг и копия; само задание (части зон) уходит первым сообщением. */
export function systemBrief(s: StepCtx, copyDir: string): string {
  return [
    'You are running one AgentDeck step.',
    `agentdeck-step: ${s.stepId}`,
    `agentdeck-copy: ${copyDir}`,
    'Work only inside the copy. When the step is done call step_done with this stepId; call blocker if you cannot continue.',
  ].join('\n');
}

export interface StartInputs {
  task: LiveTask;
  pin: Record<string, string>;
  pathPrefix?: readonly string[];
}

export type StartOutcome = { ok: true; start: RoadStart } | { ok: false; reason: string };

/** Запуск сессии шага из фактов журнала; отказ называет, чего не хватило. */
export function stepStart(input: StartInputs, s: StepCtx, sessionId: string): StartOutcome {
  const { task } = input;
  const tier = s.routing?.tier;
  if (!tier) return { ok: false, reason: 'step has no routing decision' };
  if (!tier.ok) return { ok: false, reason: `tier refused: ${tier.reasons.join('; ')}` };
  // Копия — только разложенная крючком копии; своей ядро тут не делает (одна копия на единицу).
  const placed = unitCopyOf(task, s.unitId);
  const cwd = placed?.dir ?? s.copyDir;
  if (!cwd) return { ok: false, reason: `unit ${s.unitId} has no copy` };
  // `null` — модель по умолчанию CLI: `--model` не передаётся, `modelAsked` в журнале — `null`;
  // маршрут с адресом без модели отказывает дорога, называя причину.
  const model = tier.model;
  // Аренда той же модели (`null` — модель по умолчанию CLI) и того же маршрута, ресурсы живы.
  const lease = journaledLease(task, tier.route.id, model);
  const unit = task.state.units[s.unitId];
  const resume = resumeOf(task, s, tier.adapter);
  return {
    ok: true,
    start: {
      task,
      stepId: s.stepId,
      stepKind: s.def.kind,
      adapterId: tier.adapter,
      routeId: tier.route.id,
      model,
      ...(tier.effort ? { effort: tier.effort } : {}),
      sessionId,
      dir: journaledSessionDir(task, sessionId),
      cwd,
      brief: systemBrief(s, cwd),
      deny: STEP_DENY,
      tools: toolPlanFor(s.def.kind)?.builtins ?? 'read-only',
      layer: { hooks: s.def.userLayer.hooks, skills: s.def.userLayer.skills },
      pin: input.pin,
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
      ...(lease ? { lease } : {}),
      ...(unit ? { ownedPaths: unit.ownedPaths } : {}),
      ...(placed ? { sourceRepo: placed.repo } : {}),
      ...(resume ? { resume } : {}),
      ...(tier.alternatives.length > 0
        ? {
            alternatives: tier.alternatives.map((a) => ({
              adapterId: a.adapter,
              routeId: a.route.id,
              model,
            })),
          }
        : {}),
    },
  };
}

/**
 * Продолжение из решения `continuation` шага (03:150-155): `same-session` — новый запуск
 * возобновляет разговор прежней сессии (`--resume <корень разговора>`), дельта приходит первым
 * словом (`opening`). Разговор — только у того же переходника: решение уже судит смену маршрута,
 * а здесь — страховка последней границы, чужой CLI чужого разговора не продолжает.
 */
function resumeOf(task: LiveTask, s: StepCtx, adapter: string): RoadResume | null {
  const cont = s.routing?.continuation;
  if (cont?.mode !== 'same-session') return null;
  const prior = task.state.sessions[cont.sessionId];
  if (!prior || prior.adapter !== adapter) return null;
  const lines = readJournalLines(task.dir, task.taskId).lines;
  return {
    conversationId: conversationOf(lines, cont.sessionId),
    of: cont.sessionId,
    cacheAgeMs: cont.numbers.cacheAgeMs,
  };
}
