import type {
  InboxCreateBody,
  InboxCreateReply,
  InboxItem,
  InboxSearchReply,
} from '@agentdeck/contracts/core/inbox';

/**
 * Поиск по источнику и заведение выбранного (этап 12, I7, D16, P167). Запрос человека уходит
 * ТОЛЬКО параметром `GET /v1/inbox/search` — его судит сам трекер, через модель он не идёт;
 * тело `POST /v1/inbox` несёт лишь выбранные тикеты ответа поиска, без запроса. Задачу заведение
 * не создаёт — только записи «Входящих»; ставит в очередь человек или «Сам в очередь» источника.
 */

/** Параметры поиска: источник и, если человек его написал, свой запрос (края срезаны). */
export function searchParams(sourceId: string, q: string): Record<string, string> {
  const query = q.trim();
  return query ? { sourceId, q: query } : { sourceId };
}

/** Тело заведения: выбранные тикеты одного источника, ключ повтора и доказательство страницы. */
export function createBody(
  sourceId: string,
  picked: InboxItem[],
  proof: { nonce: string; page: string },
  cmdId: string,
): InboxCreateBody {
  return { cmdId, proof, create: { source: 'search', sourceId, items: picked } };
}

/** Выбор строки: нажата выбранная — снята, иначе добавлена. */
export function togglePick(picked: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(picked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** «Выбрать все»: все выбраны — снять все, иначе выбрать все строки ответа. */
export function toggleAll(picked: ReadonlySet<string>, items: readonly InboxItem[]): Set<string> {
  const all = items.length > 0 && items.every((item) => picked.has(item.key));
  return all ? new Set() : new Set(items.map((item) => item.key));
}

/** Выбранные тикеты в порядке ответа поиска — так их и заведёт ядро. */
export function pickedItems(items: readonly InboxItem[], picked: ReadonlySet<string>): InboxItem[] {
  return items.filter((item) => picked.has(item.key));
}

/**
 * Что показать под поиском: «неизвестно» источника — причиной (список пуст не потому, что
 * ничего нет), пустой ответ — «ничего не нашлось», иначе строки и подпись обрезки.
 */
export function searchViewOf(
  reply: InboxSearchReply | undefined,
): 'none' | 'problem' | 'empty' | 'items' {
  if (!reply) return 'none';
  if (reply.problem) return 'problem';
  return reply.items.length === 0 ? 'empty' : 'items';
}

/**
 * Причина для человека: ключ строки перевода (`coreInbox.search.failures.*` / `.problems.*`) и
 * проза ядра как есть — она английская по контракту и идёт только подсказкой (`title`), не текстом.
 */
export interface CauseLine {
  key: string;
  raw: string;
}

const FAILURE_BY_CODE: Readonly<Record<string, string>> = {
  'unknown-source': 'unknownSource',
  'bad-inbox-search': 'badQuery',
  'not-wired': 'notWired',
};

/**
 * Отказ ручки поиска (`GET /v1/inbox/search` ответил не 200): по коду ядра — своя строка; ответа
 * нет вовсе — «ядро не ответило»; код незнаком — общее «ядро отказало».
 */
export function searchFailureOf(error: unknown): CauseLine {
  const response = (error as { response?: { data?: unknown } } | null)?.response;
  const data = (response?.data ?? {}) as { code?: unknown; reason?: unknown; error?: unknown };
  const raw =
    [data.reason, data.error].find((v): v is string => typeof v === 'string' && v.trim() !== '') ??
    (error instanceof Error ? error.message : String(error));
  if (!response) return { key: 'noAnswer', raw };
  const key = typeof data.code === 'string' ? FAILURE_BY_CODE[data.code] : undefined;
  return { key: key ?? 'refused', raw };
}

/**
 * «Неизвестно» источника (`problem` ответа поиска — `source <id>: <причина>` прозой ядра) — по
 * причине: не поддерживается, нечего читать, нет доступа, не настроено в панели, не найдено,
 * лимит, трекер недоступен, ответ непонятен. Незнакомая причина — общее «источник не ответил».
 * Порядок важен: «нет учётки» раньше «не настроено», коды трекера — после.
 */
const PROBLEM_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/not supported|no forge API/i, 'unsupported'],
  [/names no labels, assignee or JQL/i, 'noQuery'],
  [/\b(unauthorized|forbidden)\b|credential|token/i, 'auth'],
  [
    /is off in the panel|is not configured|no site address|settings unread|state\.json/i,
    'notConfigured',
  ],
  [/\bnot-found\b/i, 'notFound'],
  [/\brate-limited\b/i, 'rateLimited'],
  [/\bbad-response\b/i, 'badResponse'],
  [/\b(unreachable|timeout|server-error)\b|read failed/i, 'unreachable'],
];

export function searchProblemOf(problem: string): CauseLine {
  const hit = PROBLEM_RULES.find(([re]) => re.test(problem));
  return { key: hit ? hit[1] : 'generic', raw: problem };
}

/** Итог заведения числами ответа ядра: новые и уже бывшие (тот же ключ — та же запись). */
export function outcomeOf(reply: InboxCreateReply): { created: number; existing: number } {
  return { created: reply.created.length, existing: reply.existing.length };
}
