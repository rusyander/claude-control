import type { AppState } from './app-store.types.ts';
import type { PlatformHealthRecord, PlatformModelInfo } from '@agentdeck/contracts';

/**
 * Итог последней пробы контура — срез состояния панели.
 *
 * Зеркало `integration-health.ts` и `mcp-health.ts`, и по той же причине:
 * матрица возможностей, посчитанная пробой, живёт дольше одной страницы. Без
 * этого раздел «Контур» после F5 показывал бы «не проверялся» по контуру,
 * который отвечает, а мастер подключения заставлял бы проверять заново.
 *
 * Секрета в записи нет: наружу из пробы уходят только адрес без ключа, коды
 * ответов, имена моделей и причины словами — ровно то, что панель и так рисует.
 */

export function getPlatformHealth(state: AppState): Record<string, PlatformHealthRecord> {
  const raw = structuredClone(state.platformHealth ?? {});
  for (const [id, record] of Object.entries(raw)) raw[id] = normalize(record);
  return raw;
}

/**
 * Запись, приведённая к нынешней форме.
 *
 * `platformHealth` в `state.json` не проверяется схемой (`record(string(),
 * unknown())`), поэтому на диске у человека, обновившего панель, лежит
 * `models: ['gpt-4o', …]` — строки там, где код ждёт объекты, а у записи,
 * пришедшей импортом с чужой машины, поля может не быть вовсе. Без приведения
 * первый же `model.id` дал бы `undefined` в каждой строке каталога, а `.map` по
 * отсутствующему полю — падение записи пробы целиком. Стирать запись нельзя:
 * тогда исправный контур после обновления читался бы как «не проверялся».
 *
 * Приводятся ВСЕ списки записи, а не один `models`: карточка контура читает
 * `capabilities.length` и `notes.map` без страховки, потому что тип обещает
 * массивы, — а запись, пришедшая импортом, обещание типа не выполняет, и
 * раздел «Контур» уходил в экран ошибки целиком.
 *
 * Возвращает КОПИЮ: запись приходит сюда и от вызывающего, и портить чужой
 * объект по дороге в хранилище — не дело хранилища.
 */
function normalize(record: PlatformHealthRecord): PlatformHealthRecord {
  return {
    ...record,
    models: asModels(record.models),
    capabilities: asList(record.capabilities),
    notes: asList(record.notes),
    compromises: asList(record.compromises),
    limits: record.limits && typeof record.limits === 'object' ? record.limits : {},
    ...(record.retired ? { retired: asModels(record.retired) } : {}),
  };
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asModels(value: unknown): PlatformModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? { id: item } : item))
    .filter(
      (item): item is PlatformModelInfo =>
        Boolean(item) && typeof (item as PlatformModelInfo).id === 'string',
    );
}

export function savePlatformHealth(
  state: AppState,
  id: string,
  incoming: PlatformHealthRecord,
): void {
  state.platformHealth ??= {};
  const record = normalize(incoming);
  const stored = state.platformHealth[id];
  const previous = stored ? normalize(stored) : undefined;

  // Дата последнего УСПЕХА переживает неудачную пробу: «контур не отвечает, а
  // три часа назад отвечал» — это про сеть, а «не отвечал ни разу» — про
  // настройку, и лечатся они в разных местах. Затирать первую второй нельзя.
  const lastOkAt = record.outcome === 'ok' ? record.checkedAt : previous?.lastOkAt;
  const retired = retiredModels(previous, record);
  const { knownIds, newIds } = freshModels(previous, record);

  // Всё, что проба УЗНАЛА, переживает неудачную пробу: «контур не ответил» и
  // «у ключа больше нет моделей» (нет возможностей, нет лимитов) — разные
  // утверждения, и второе панель не проверяла. У неудачной пробы эти поля
  // пусты всегда (она возвращает пустой каркас), поэтому затирание превращало
  // любой обрыв сети в пустой каталог и в матрицу «не проверяли» по контуру,
  // который отвечал час назад. Когда это было правдой, говорит `lastOkAt` — он
  // показывается рядом. Исход, причина и время остаются от НЫНЕШНЕЙ пробы.
  const known = record.outcome === 'ok' ? record : (previous ?? record);

  state.platformHealth[id] = {
    ...record,
    models: known.models,
    capabilities: known.capabilities,
    limits: known.limits,
    notes: known.notes,
    compromises: known.compromises,
    ...(lastOkAt ? { lastOkAt } : {}),
    ...(retired.length > 0 ? { retired } : {}),
    ...(knownIds.length > 0 ? { knownIds } : {}),
    ...(newIds.length > 0 ? { newIds } : {}),
  };
}

/**
 * Что у контура появилось впервые.
 *
 * Зеркало «новинок» каталога models.dev и по той же причине: выданная ключу
 * новая модель — событие, ради которого человек сюда и заходит, а в списке из
 * сорока строк она ничем не выделяется. Считается только по УДАЧНОЙ пробе;
 * на первой новинок нет — новинка это то, чего не было в прошлый раз, а
 * прошлого раза ещё не случалось. Вернувшаяся модель новинкой не становится:
 * она есть в `knownIds`.
 */
function freshModels(
  previous: PlatformHealthRecord | undefined,
  next: PlatformHealthRecord,
): { knownIds: string[]; newIds: string[] } {
  if (next.outcome !== 'ok') {
    return { knownIds: previous?.knownIds ?? [], newIds: previous?.newIds ?? [] };
  }

  const known = new Set(previous?.knownIds ?? []);
  const first = known.size === 0;
  const newIds = first ? [] : next.models.map((m) => m.id).filter((id) => !known.has(id));

  for (const model of next.models) known.add(model.id);
  return { knownIds: [...known], newIds };
}

/**
 * Что контур отдавал раньше и перестал.
 *
 * Считается ЗДЕСЬ, потому что это единственное место, которое видит оба ответа
 * сразу. Молча исчезнувшая из выбора модель читается человеком как поломка
 * панели: он ищет её глазами и не находит, а причина — на стороне контура.
 *
 * Только по УДАЧНОЙ пробе: неудачная ничего не говорит о составе списка, и
 * считать по ней значило бы объявить пропавшими все модели разом при первом же
 * обрыве сети. Уже отмеченные пропавшими переносятся дальше с той датой, когда
 * их видели, — но вернувшаяся модель пометку теряет.
 */
function retiredModels(
  previous: PlatformHealthRecord | undefined,
  next: PlatformHealthRecord,
): PlatformModelInfo[] {
  if (next.outcome !== 'ok') return previous?.retired ?? [];

  const alive = new Set(next.models.map((model) => model.id));
  const retired: PlatformModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of previous?.retired ?? []) {
    if (alive.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    retired.push(model);
  }

  // «Последняя встреча» — это последний УСПЕХ, а не последняя проба: список
  // переживает неудачные, и между двумя удачными их могло быть сколько угодно.
  // По `checkedAt` вышло бы «видели в 12:00» о минуте, в которую контур не
  // ответил ничего. У записи без даты успеха остаётся дата нынешней пробы —
  // соврать «видели тогда-то» хуже, чем показать день обнаружения пропажи.
  const lastSeenAt = previous?.lastOkAt ?? previous?.checkedAt ?? next.checkedAt;
  for (const model of previous?.models ?? []) {
    if (alive.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    retired.push({ ...model, retired: true, lastSeenAt });
  }

  return retired;
}

/** Контур удалён — вместе с ним уходит и след пробы. */
export function forgetPlatformHealth(state: AppState, id: string): boolean {
  if (!state.platformHealth || !(id in state.platformHealth)) return false;
  delete state.platformHealth[id];
  return true;
}
