import type { Platform } from '@agentdeck/contracts';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import { endpointFileRoute } from '../../domains/platform/apply/current.ts';
import {
  resolveRunRoute,
  type PlatformRoutingDeps,
} from '../../domains/platform/routing/routing.ts';
import { readPlatforms } from '../../domains/platform/store/store.ts';
import { getProvider, isKnownProviderId } from '../../providers/registry.ts';

/** Маршрут дешёвой доставки: через контур ли прогон и какие имена знает его карта. */
export interface ForeignDeliverRoute {
  routed: boolean;
  modelMapKeys?: readonly string[];
}

/**
 * Ключи карты моделей так, как их сверяет маршрут прогона (`resolveRunRoute`):
 * без пустых строк, обрезанные и строчные.
 */
function mapKeysOf(modelMap: Record<string, string>): string[] {
  return Object.entries(modelMap)
    .filter(([from, to]) => from.trim() && to.trim())
    .map(([from]) => from.trim().toLowerCase());
}

/**
 * «Через контур» с картой названного контура. Контура в настройках нет
 * (удалён, файл не откатан) или карта пуста — без ключей: младшая ступень закрыта.
 */
function routedVia(platform: Platform | undefined): ForeignDeliverRoute {
  const keys = platform ? mapKeysOf(platform.modelMap) : [];
  return keys.length > 0 ? { routed: true, modelMapKeys: keys } : { routed: true };
}

/**
 * Контур, применённый к СОБСТВЕННОМУ файлу этого CLI (Codex — `config.toml`):
 * такой файл уводит в шлюз каждый его прогон, группы тоже, что бы ни решило
 * окружение. Карта — того контура, чей след лежит на файле.
 */
function appliedFileRoute(
  routing: PlatformRoutingDeps,
  providerId: string,
  platforms: readonly Platform[],
): ForeignDeliverRoute | undefined {
  const applied = Object.values(routing.store.getPlatformApplied()).find((record) =>
    record.targets.some((target) => target.targetId === providerId),
  );
  if (!applied) return undefined;
  return routedVia(platforms.find((item) => item.id === applied.platformId));
}

/**
 * Сам файл CLI, когда следа нет: откат оставляет правленный рукой файл как есть
 * (`kept`) и всё равно вычёркивает цель, а запись шлюза, вписанную человеком,
 * след не знает вовсе. Файл читается разбором `endpointFileRoute`; не читается —
 * «через контур без ключей».
 */
function ownFileRoute(
  routing: PlatformRoutingDeps,
  providerId: string,
  platforms: readonly Platform[],
): ForeignDeliverRoute {
  const file = isKnownProviderId(providerId) ? getProvider(providerId).endpointFile : undefined;
  if (!file) return { routed: false };
  const route = endpointFileRoute(
    file,
    platforms.map((item) => item.id),
    routing.gatewayPort(),
  );
  if (!route.routed) return { routed: false };
  return routedVia(platforms.find((item) => item.id === route.platformId));
}

/**
 * Маршрут CLI через контур для дешёвой доставки чужой группы (`contourRoute`
 * планировщика стадий): тот же потребитель `foreign:<cli>`, что у прогона; если
 * окружение его не уводит — след применения контура к файлу CLI; нет и следа —
 * сам собственный файл CLI (`endpointFile`), прочитанный сейчас. На контуре
 * младшая ступень берётся, только если её имя есть в карте моделей. Ошибка здесь
 * только в сторону «через контур»: ответ «мимо» без проверки файла пустил бы в
 * контур модель без строки карты.
 */
export function foreignDeliverContourRoute(
  routing: PlatformRoutingDeps,
  providerId: string,
): ForeignDeliverRoute {
  const decision = resolveRunRoute(routing, foreignConsumerId(providerId));
  if (decision.routed) {
    return {
      routed: true,
      ...(decision.modelMapKeys ? { modelMapKeys: decision.modelMapKeys } : {}),
    };
  }
  const platforms = readPlatforms(routing.store);
  return (
    appliedFileRoute(routing, providerId, platforms) ?? ownFileRoute(routing, providerId, platforms)
  );
}
