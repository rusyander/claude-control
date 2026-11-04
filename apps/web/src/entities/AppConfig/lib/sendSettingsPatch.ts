import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings, AppSettingsPatch } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { applySettingsUpdate, applyPatchEffects } from './applySettingsUpdate';

/**
 * Правка настроек: готовый патч или функция от настроек в кеше на момент правки.
 * Функция нужна полям-спискам (`endpointProfiles`): сервер сливает патч
 * поверхностно, и список, собранный из снимка прошлой отрисовки, затирал правку,
 * ещё не дошедшую до кеша.
 */
export type SettingsPatchInput =
  AppSettingsPatch | ((current: AppSettings | undefined) => AppSettingsPatch);

interface PatchQueue {
  /** Хвост очереди отправки: следующий PATCH уходит после ответа предыдущего. */
  tail: Promise<unknown>;
  /** Правки, ответ на которые ещё не пришёл. */
  pending: number;
  /** Сколько правок было всего: чтение настроек сверяет его до и после запроса. */
  edits: number;
  /** Запрос, ещё не ушедший: новые правки сливаются в него. */
  next?: QueuedSend;
}

interface QueuedSend {
  patch: AppSettingsPatch;
  result: Promise<AppSettings>;
}

// Очередь на клиент запросов, а не на хук: два тумблера страницы — два экземпляра
// мутации над одним кешем.
const queues = new WeakMap<QueryClient, PatchQueue>();

function queueOf(queryClient: QueryClient): PatchQueue {
  let queue = queues.get(queryClient);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0, edits: 0 };
    queues.set(queryClient, queue);
  }
  return queue;
}

/**
 * `GET /settings`, не откатывающий свои правки. Каждый PATCH сервер отражает в
 * поток событий, и панель перечитывает настройки (`refreshSettingsFromServer`);
 * перечитаны они и по фокусу окна. Чтение, начатое до правки или пришедшее, пока
 * правки в пути, несёт промежуточное состояние сервера: положенное в кеш, оно
 * стирало набранное — поле адреса теряло буквы прямо под пальцами. Такой ответ
 * отбрасывается (`stale`), в кеше остаётся своя правка; правду принесёт ответ
 * последней из них.
 */
export async function readSettings(
  queryClient: QueryClient,
  fetch: () => Promise<AppSettings>,
): Promise<{ settings: AppSettings; stale: boolean }> {
  const queue = queueOf(queryClient);
  const mark = queue.edits;
  const fresh = await fetch();
  const cached = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const stale = queue.pending > 0 || queue.edits !== mark;
  return stale && cached ? { settings: cached, stale: true } : { settings: fresh, stale: false };
}

/**
 * `PATCH /settings`: правка видна сразу, на сервер уходит по очереди.
 *
 * Сервер сливает патч поверхностно, поля целиком заменяются. Две быстрые правки
 * внахлёст (имя и адрес профиля эндпоинта, буквы одного поля) раньше собирались
 * из одного устаревшего снимка, и вторая затирала первую; ответ первой, пришедший
 * поверх второй, ещё и откатывал поле ввода. Теперь:
 *   - патч считается от кеша В МОМЕНТ правки и сразу ложится в кеш — следующая
 *     правка видит предыдущую;
 *   - запросы уходят строго по одному, сервер применяет их в порядке правок;
 *   - правки, сделанные, пока запрос в пути, сливаются в ОДИН следующий запрос
 *     тем же поверхностным слиянием, что у сервера: набор адреса по букве не
 *     выстраивает на медленном сервере хвост из десятков PATCH;
 *   - ответ кладётся в кеш, только когда за ним в очереди никого нет: промежуточный
 *     ответ не знает о следующих правках и откатил бы их на экране. Сбросы
 *     чужих разделов (смена провайдера) делаются на каждый ответ;
 *   - отказ, после которого очередь пуста, перечитывает настройки: правду знает сервер.
 */
export function sendSettingsPatch(
  queryClient: QueryClient,
  input: SettingsPatchInput,
  send: (patch: AppSettingsPatch) => Promise<AppSettings>,
): Promise<AppSettings> {
  const queue = queueOf(queryClient);
  const current = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const patch = typeof input === 'function' ? input(current) : input;
  if (current) queryClient.setQueryData(queryKeys.settings, { ...current, ...patch });
  queue.edits += 1;

  if (queue.next) {
    queue.next.patch = { ...queue.next.patch, ...patch };
    return queue.next.result;
  }

  const waiting: QueuedSend = { patch, result: Promise.resolve(undefined as never) };
  queue.pending += 1;
  const run = async (): Promise<AppSettings> => {
    // С этого мига запрос ушёл: следующие правки копятся уже в новый.
    if (queue.next === waiting) queue.next = undefined;
    const sent = waiting.patch;
    try {
      const settings = await send(sent);
      queue.pending -= 1;
      if (queue.pending === 0) applySettingsUpdate(queryClient, settings, sent);
      else applyPatchEffects(queryClient, sent);
      return settings;
    } catch (error) {
      queue.pending -= 1;
      if (queue.pending === 0) void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      throw error;
    }
  };
  // Свободная очередь отправляет сразу; занятая — после ответа текущего запроса,
  // а до тех пор этот запрос принимает следующие правки.
  const idle = queue.pending === 1;
  if (!idle) queue.next = waiting;
  waiting.result = idle ? run() : queue.tail.then(run, run);
  queue.tail = waiting.result.catch(() => undefined);
  return waiting.result;
}
