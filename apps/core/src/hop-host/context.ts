import type { ServerResponse } from 'node:http';
import type { DlpRule } from '@agentdeck/contracts';
import { builtinRuleSet, maskRulesFor } from '@agentdeck/dlp/default-rules';
import type { DlpApiKind } from '@agentdeck/dlp/api-shapes';
import type { ActivityBook } from './activity/activity.ts';
import type { ContourBook } from './contour-book/contour-book.ts';
import { hopText, type TextLanguage } from './gateway/texts.ts';
import type { ThinkTailModels } from './gateway/think-models.ts';
import type { KeySource, TagEntry } from './host.types.ts';
import { joinUpstream, refuse } from './http.ts';
import type { SpendBook } from './spend.ts';
import type { TagRegistry } from './tags.ts';
import type { HopTrace } from './trace.ts';

/**
 * Что звену нужно на каждом запросе: известные сеансы, учёт, след, источник ключей, правила
 * маски, язык отказов и пределы времени. Один объект на процесс хоста; подменяется в тестах.
 */
export interface HopContext {
  tags: TagRegistry;
  spend: SpendBook;
  /** Учёт контуров (след, расход по дням, отказ по бюджету) — то, что читают панель и ядро. */
  contours: ContourBook;
  trace: HopTrace;
  keys: KeySource;
  /** Правила маски: свои правила панели или встроенный набор; битый файл — `broken`. */
  rules(): { rules: DlpRule[] } | { broken: string };
  language: TextLanguage;
  /** Тишина наверху дольше этого — запрос обрывается и называется (мс). */
  stallMs: number;
  retryPauseMs: number;
  /** Каталог состояния звена (журнал сжатий, модели с хвостом размышлений). */
  stateDir: string;
  thinkTail: ThinkTailModels;
  now(): number;
  fetchImpl?: typeof fetch;
  /** Лента хода локальных маршрутов (op `activity`); нет — запросы её не ведут (тесты ручек). */
  activity?: ActivityBook;
}

/** Правила маски из каталога данных панели; каталога нет — встроенный набор (как у панели). */
export function rulesFrom(panelAppData: string | undefined): HopContext['rules'] {
  return () => {
    if (!panelAppData) return { rules: builtinRuleSet() };
    const set = maskRulesFor(panelAppData);
    return set.source === 'broken' ? { broken: set.error } : { rules: set.rules };
  };
}

/** Маска на сеансе: политика требует её, ядро зафиксировало набор правил или прислало их. */
export function maskingOn(entry: TagEntry): boolean {
  const { dlp } = entry.spec;
  return dlp.required || dlp.rulesHash !== null || (dlp.rules?.length ?? 0) > 0;
}

/**
 * Правила маски сеанса: присланные регистрацией — ровно они (данные, не файлы панели); иначе
 * правила хоста (каталог данных панели или встроенный набор).
 */
export function rulesOf(
  ctx: Pick<HopContext, 'rules'>,
  spec: Pick<TagEntry['spec'], 'dlp'>,
): ReturnType<HopContext['rules']> {
  const own = spec.dlp.rules;
  return own && own.length > 0 ? { rules: own } : ctx.rules();
}

/**
 * Контекст запроса сеанса: язык отказов — сеанса, если он его назвал (`HopRegisterSpec.language`),
 * иначе хоста. Остальное — тот же объект процесса (учёт, след, метки — общие).
 */
export function sessionContext(ctx: HopContext, entry: TagEntry): HopContext {
  const language = entry.spec.language;
  return language === undefined || language === ctx.language ? ctx : { ...ctx, language };
}

/**
 * Маршрут исчерпан ответом 402 — звено держит его до `clear-exhausted` человека и не ходит туда
 * вовсе (P122 «no keep-warm into it»). `true` — отказ уже ушёл клиенту.
 */
export function refuseIfExhausted(
  ctx: HopContext,
  entry: TagEntry,
  response: ServerResponse,
  kind: DlpApiKind,
): boolean {
  const at = ctx.spend.exhaustedAt(entry.spec.routeId);
  if (at === undefined) return false;
  refuse(
    response,
    kind,
    {
      status: 402,
      code: 'billing_error',
      message: hopText('hop-exhausted', { route: entry.spec.routeId }),
    },
    ctx.language,
  );
  return true;
}

/** Ключ по умолчанию диалекта верха: `x-api-key` у Anthropic, `Authorization: Bearer` у прочих. */
function dialectAuth(entry: TagEntry): { header: string; scheme: string } {
  return entry.spec.to === 'anthropic-messages'
    ? { header: 'x-api-key', scheme: '' }
    : { header: 'authorization', scheme: 'Bearer' };
}

/**
 * Верх — корень API с версией: `/v1/<rest>` клиента становится `<корень>/<rest>`, как у панели
 * (`platformRequestUrl`: `…/api/v2` + `chat/completions`, режим `as-is` без `/v1`).
 */
function rootedJoin(upstream: string, path: string): string {
  const base = new URL(upstream);
  const root = base.pathname.replace(/\/+$/, '');
  const mark = path.indexOf('?');
  const bare = mark < 0 ? path : path.slice(0, mark);
  const rest = bare.replace(/^\/v1(?=\/|$)/, '').replace(/^\/+/, '');
  return `${base.origin}${root}/${rest}${mark < 0 ? '' : path.slice(mark)}`;
}

/**
 * Адрес верха: origin и путь регистрации + путь диалекта, поверх — параметры контура
 * (`upstreamQuery`, например `api-version` Azure): без них контур отвечает 404 при зелёной пробе.
 */
export function upstreamUrl(entry: TagEntry, path: string): string {
  const url = new URL(
    entry.spec.upstreamRooted
      ? rootedJoin(entry.spec.upstream, path)
      : joinUpstream(entry.spec.upstream, path),
  );
  for (const [name, value] of Object.entries(entry.spec.upstreamQuery))
    url.searchParams.set(name, value);
  return url.toString();
}

/**
 * Заголовки доступа наверх. Ключ — по ссылке маршрута, на этом запросе; входящая заглушка
 * не уходит наверх никогда, кроме цепочки звеньев (`hop-injected`), где её узнаёт следующее звено.
 * Заголовок ключа — карточки контура или пресета (`upstreamAuth`), иначе диалекта; постоянные
 * заголовки контура кладутся ПЕРВЫМИ, и ключ ими не перебивается (как `platformRequestHeaders`).
 */
export function upstreamAuth(
  ctx: HopContext,
  entry: TagEntry,
  credential: string,
): { headers: Record<string, string>; secret?: string } | { refusal: string } {
  const ref = entry.spec.keyRef;
  const fixed = entry.spec.upstreamHeaders;
  if (ref === null) return { headers: { ...fixed } };
  // Следующее звено цепи узнаёт заглушку только в `x-api-key`/`Bearer` (`credentialOf`).
  const auth =
    ref.kind === 'hop-injected'
      ? dialectAuth(entry)
      : (entry.spec.upstreamAuth ?? dialectAuth(entry));
  const name = auth.header.toLowerCase();
  const header = (value: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(fixed))
      if (key.toLowerCase() !== name) out[key] = item;
    out[name] = auth.scheme ? `${auth.scheme} ${value}` : value;
    return out;
  };
  if (ref.kind === 'hop-injected') return { headers: header(credential) };
  // Ключ `env` сеанса ядро передало при регистрации (в памяти метки); нет — окружение хоста.
  const own = ref.kind === 'env' ? ctx.tags.sessionKey(entry.spec.tag) : undefined;
  if (own) return { headers: header(own), secret: own };
  const read = ctx.keys.resolve(ref);
  if ('value' in read) return { headers: header(read.value), secret: read.value };
  const reason = 'absent' in read ? 'absent' : read.unknown;
  return { refusal: hopText('hop-key-unresolved', { route: entry.spec.routeId, reason }) };
}
