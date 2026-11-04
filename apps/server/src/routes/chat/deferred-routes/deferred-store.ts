import { join } from 'node:path';
import type { ServerContext } from '../../../context.ts';
import type { DeferredDecisionResult } from '@agentdeck/contracts/deferred-asks';
import {
  DEFERRED_ASKS_FILE,
  DeferredAsks,
  deferredView,
  type DeferredDecisionInput,
} from '../../../domains/chat/deferred-asks/deferred-asks.ts';

const DAY_MS = 86_400_000;

/**
 * Одна запись D-n на сервер и на его папку данных: мост прав (`run-routes.ts`),
 * список и решение (`deferred-routes.ts`), и сводка (`inbox-routes`)
 * обязаны видеть ОДИН объект — иначе запись,
 * заведённая мостом, не нашлась бы решению. Ключ — контекст сервера, а внутри —
 * путь папки данных: смена каталога конфигурации (`context.ts`) меняет и её.
 * Два сервера в одном процессе (тесты) не делят записей.
 */
const stores = new WeakMap<ServerContext, Map<string, DeferredAsks>>();

export function deferredAsksOf(ctx: ServerContext): DeferredAsks {
  const appData = ctx.location.paths.appData;
  let byDir = stores.get(ctx);
  if (!byDir) {
    byDir = new Map();
    stores.set(ctx, byDir);
  }
  let store = byDir.get(appData);
  if (!store) {
    store = new DeferredAsks({
      file: join(appData, DEFERRED_ASKS_FILE),
      ttlMs: () => (ctx.store.getSettings().deferredTtlDays ?? 7) * DAY_MS,
      log: (message, detail) => console.warn(`[agentdeck] ${message}`, detail ?? ''),
    });
    byDir.set(appData, store);
  }
  return store;
}

/**
 * Единственный путь решения D-n — окно, телефон, ссылка из Telegram и кнопки
 * карточки в ленте зовут его одинаково. Повторный ответ ничего не меняет;
 * истёкшую запись разрешить можно заново. Решение только записывается: ход
 * разговора после него панель больше не заводит — продолжатель панели снят
 * вместе с её запуском CLI (этап 10, G14; чат ведёт ядро), поэтому поля
 * `resume` в ответе нет.
 */
export async function decideDeferred(
  ctx: ServerContext,
  id: string,
  decision: DeferredDecisionInput,
): Promise<DeferredDecisionResult | undefined> {
  const asks = deferredAsksOf(ctx);
  const outcome = asks.decide(id, decision);
  if (!outcome) return undefined;
  const { record, changed } = outcome;
  return { item: deferredView(asks.get(record.id) ?? record), changed };
}
