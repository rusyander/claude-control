import { join } from 'node:path';
import type { ServerContext } from '../../../context.ts';
import type { DeferredDecisionResult } from '@agentdeck/contracts/deferred-asks';
import {
  DEFERRED_ASKS_FILE,
  DeferredAsks,
  deferredView,
  type DeferredAskRecord,
  type DeferredDecisionInput,
} from '../../../domains/chat/deferred-asks/deferred-asks.ts';

const DAY_MS = 86_400_000;

/**
 * Одна запись D-n на сервер и на его папку данных: мост прав (`run-routes.ts`),
 * список и решение (`deferred-routes.ts`), сводка (`inbox-routes`) и сборка
 * (продолжение, обход при старте) обязаны видеть ОДИН объект — иначе запись,
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

export type DeferredResumeOutcome = NonNullable<DeferredDecisionResult['resume']>;
/** Продолжить разговор после решения (сборка: `bootstrap/deferred-wiring`). */
export type DeferredResumer = (record: DeferredAskRecord) => Promise<DeferredResumeOutcome>;

const resumers = new WeakMap<ServerContext, DeferredResumer>();

/** Сборка сервера ставит продолжение; без него решение только записывается (юниты). */
export function setDeferredResumer(ctx: ServerContext, resumer: DeferredResumer): void {
  resumers.set(ctx, resumer);
}

/**
 * Единственный путь решения D-n — окно, телефон, ссылка из Telegram и кнопки
 * карточки в ленте зовут его одинаково. Повторный ответ ничего не меняет и
 * продолжения второй раз не заводит; истёкшую запись разрешить можно заново.
 * Продолжение ДОШЛО до разговора — запись помечается, и обход при старте его не
 * повторит; «в очереди» (`queued`) и «отложено в памяти» (`parked`) не
 * помечаются: это слово в памяти, и перезапуск панели до его доставки продолжит
 * запись обходом (D-L02).
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
  let resume: DeferredResumeOutcome | undefined;
  const resumer = resumers.get(ctx);
  if (changed && resumer) {
    try {
      resume = await resumer(record);
    } catch {
      resume = 'none';
    }
    // «Сказано» помечает сборка — по факту ДОСТАВКИ (`onSent` очереди), не по
    // ответу «sent»: перезапуск стадии группы отвечает «sent», а слова о D-n не
    // несёт, и пометка здесь теряла бы его (D-L02, RF-DL-04).
  }
  return {
    item: deferredView(asks.get(record.id) ?? record),
    changed,
    ...(resume ? { resume } : {}),
  };
}
