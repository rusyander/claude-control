import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings, AppSettingsPatch } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { applySettingsUpdate, applyPatchEffects } from './applySettingsUpdate';

interface PatchOrder {
  /** Номер последнего отправленного PATCH. */
  issued: number;
  /** Номер PATCH, чей ответ лежит в кеше. */
  applied: number;
  inFlight: number;
  /** Запросы шли внахлёст — сервер мог применить их не в том порядке, в каком ушли. */
  overlapped: boolean;
}

// Счёт на клиент запросов, а не на хук: два тумблера страницы — два экземпляра
// мутации над одним кешем.
const orders = new WeakMap<QueryClient, PatchOrder>();

function orderOf(queryClient: QueryClient): PatchOrder {
  let order = orders.get(queryClient);
  if (!order) {
    order = { issued: 0, applied: 0, inFlight: 0, overlapped: false };
    orders.set(queryClient, order);
  }
  return order;
}

/**
 * `PATCH /settings` с раскладкой ответа по кешу в порядке отправки (F-28 ревью П1).
 * Два быстрых переключения: ответ первого мог прийти позже второго и вернуть на
 * экран состояние без второй правки, хотя сервер хранил обе. Ответ старше уже
 * разложенного в кеш не кладётся (его сбросы разделов — да); а когда последний из
 * шедших внахлёст запросов закончился, настройки перечитываются — сервер мог
 * применить их в другом порядке, и тогда правду знает только он.
 */
export async function sendSettingsPatch(
  queryClient: QueryClient,
  patch: AppSettingsPatch,
  send: (patch: AppSettingsPatch) => Promise<AppSettings>,
): Promise<AppSettings> {
  const order = orderOf(queryClient);
  const ticket = ++order.issued;
  order.inFlight += 1;
  if (order.inFlight > 1) order.overlapped = true;
  try {
    const settings = await send(patch);
    if (ticket > order.applied) {
      order.applied = ticket;
      applySettingsUpdate(queryClient, settings, patch);
    } else {
      applyPatchEffects(queryClient, patch);
    }
    return settings;
  } finally {
    order.inFlight -= 1;
    if (order.inFlight === 0 && order.overlapped) {
      order.overlapped = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    }
  }
}
