import type { ReleaseOutcome, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { RouteRegistry } from '../routes/registry.ts';

/**
 * Чистая остановка ядра для маршрутов: каждый маршрут реестра, у которого есть `shutdown`,
 * освобождает всё, что держит (заглушка, своя модель — их серверы живут отдельными процессами и
 * переживают крах ядра). Имя маршрута здесь не называется: перебор реестра, не особый случай.
 * Отказ одного маршрута не останавливает остальных и не бросает — остановка ядра идёт дальше,
 * отказ названной утечкой ложится в журнал ядра.
 */
export async function shutdownRoutes(
  routes: RouteRegistry,
  note: (event: string, data: Record<string, unknown>) => void,
): Promise<ReleaseOutcome> {
  const total: ReleaseOutcome = { verified: [], leaks: [] };
  for (const route of routes.list()) {
    if (!route.shutdown) continue;
    // Остановка только освобождает: решений и новых ресурсов в ней нет.
    const record: RouteRecorder = {
      decision: () => undefined,
      created: () => undefined,
      verified: (rid, fact) => note('route.released', { route: route.id, rid, fact }),
      leak: (rid, reason) => note('route.leak', { route: route.id, rid, reason }),
    };
    try {
      const outcome = await route.shutdown(record);
      total.verified.push(...outcome.verified);
      total.leaks.push(...outcome.leaks);
    } catch (error) {
      const reason = `shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      note('route.leak', { route: route.id, rid: null, reason });
      total.leaks.push({ rid: `route:${route.id}`, reason });
    }
  }
  return total;
}
