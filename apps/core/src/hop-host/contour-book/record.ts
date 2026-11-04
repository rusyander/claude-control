import type { PlatformGatewayEvent, PlatformViolationAction } from '@agentdeck/contracts';
import type { HopTraceEntry } from '../host.types.ts';

/**
 * След запроса контура в форме, которую читала карточка шлюза панели (`PlatformGatewayEvent`).
 * Строится из той же строки следа звена (`HopTraceEntry`) плюс фактов кадров контура — второго
 * источника истины у следа нет. Тел, ключей и текста, на котором сработали проверки, здесь нет.
 */

const CONTOUR_ROUTE = 'gateway:';

/** Контур маршрута (`gateway:<id>`, `gatewayRouteId` ядра); не контур — `undefined`. */
export function contourIdOf(routeId: string): string | undefined {
  if (!routeId.startsWith(CONTOUR_ROUTE)) return undefined;
  const id = routeId.slice(CONTOUR_ROUTE.length);
  return id === '' ? undefined : id;
}

/** Маршрут контура по его id (обратное `contourIdOf`). */
export function contourRouteId(platformId: string): string {
  return `${CONTOUR_ROUTE}${platformId}`;
}

/** Факты ответа, которых нет в строке следа (кадры контура, прослойка инструментов). */
export interface ContourEventFacts {
  stages: string[];
  summarized: boolean;
  messageId: string;
  violationActions: Record<string, PlatformViolationAction[]>;
  blocked: boolean;
  interrupted: boolean;
  unknownFrames: string[];
  shimmed: string[];
  toolCalls: number;
  contourCalls: number;
  nativeCalls: number;
  toolFlaws: string[];
  toolsBlocked: string[];
  claimedWithoutCall: boolean;
  rewritten: 'diverged';
}

export interface ContourEventInput {
  at: number;
  platformId: string;
  path: string;
  /** Диалект клиента. */
  dialect: string;
  runTag?: string;
  section?: string;
  trace: Partial<HopTraceEntry> & { status: number };
  facts?: Partial<ContourEventFacts>;
}

export function contourEvent(input: ContourEventInput): PlatformGatewayEvent {
  const { trace, facts = {} } = input;
  return {
    at: new Date(input.at).toISOString(),
    platformId: input.platformId,
    path: input.path,
    dialect: input.dialect,
    status: trace.status,
    stages: facts.stages ?? [],
    summarized: facts.summarized ?? false,
    ...(facts.messageId ? { messageId: facts.messageId } : {}),
    ...(input.runTag ? { runTag: input.runTag } : {}),
    ...(input.section ? { section: input.section } : {}),
    violations: trace.violations ?? [],
    ...(facts.violationActions && Object.keys(facts.violationActions).length > 0
      ? { violationActions: facts.violationActions }
      : {}),
    masked: trace.masked ?? false,
    blocked: facts.blocked ?? false,
    interrupted: facts.interrupted ?? false,
    unknownFrames: facts.unknownFrames ?? [],
    lost: trace.lost ?? [],
    shimmed: facts.shimmed ?? [],
    toolCalls: facts.toolCalls ?? 0,
    contourCalls: facts.contourCalls ?? 0,
    ...(facts.nativeCalls ? { nativeCalls: facts.nativeCalls } : {}),
    toolFlaws: facts.toolFlaws ?? [],
    ...(facts.toolsBlocked?.length ? { toolsBlocked: facts.toolsBlocked } : {}),
    claimedWithoutCall: facts.claimedWithoutCall ?? false,
    ...(trace.imageBytes ? { imageBytes: trace.imageBytes } : {}),
    ...(facts.rewritten ? { rewritten: facts.rewritten } : {}),
    totalTokens: trace.tokens ?? 0,
    ...(trace.usageUnreported ? { usageUnreported: true } : {}),
    error: trace.error,
  };
}
