import { createHash } from 'node:crypto';
import type {
  BaseCacheFile,
  BaseDeps,
  BaseKey,
  BaseOutcome,
  BaseRecord,
  Drift,
  ProbeTrace,
} from './base.types.ts';

/**
 * Базовый контекст сеанса (03 §Context, G9): системный промпт CLI + список навыков + имена
 * инструментов MCP + правила — всё, что идёт в первый ход до брифа. Меряется пробой на заглушке
 * модели (бесплатно, без сети): тело запроса первого хода минус бриф. Ключ — весь набор, от
 * которого база зависит (CLI, его версия, вид шага, набор слоя, список MCP); замер кэшируется в
 * доме ядра и перемеряется, когда живой ход разошёлся с ожиданием больше чем на 20 %
 * (`signal context-drift`).
 *
 * Токены — оценка `ceil(bytes / 4)`, та же, что у `count_tokens` заглушки: точный счёт —
 * у модели, а здесь нужен порядок для бюджета и деления на единицы.
 */

export const BYTES_PER_TOKEN = 4;
export const DRIFT_LIMIT = 0.2;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Канонический JSON: ключи по порядку — один набор даёт один отпечаток. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Отпечаток набора (слой человека, список MCP шага) для ключа базы. */
export const setHash = (value: unknown): string => sha256(canonical(value));

export const baseKeyId = (key: BaseKey): string =>
  [key.adapter, key.cliVersion, key.stepKind, key.layerHash, key.mcpHash].join('|');

export const tokensOf = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN);

/**
 * База из следа пробы: тело первого запроса, что несёт бриф (служебные запросы CLI — заголовок,
 * подсчёт — брифа не несут), минус бриф в том виде, в каком он лежит в JSON тела. Брифа нет ни в
 * одном теле — замер не годен: база без вычета была бы завышена на весь бриф.
 */
export function measureBase(trace: ProbeTrace): { bytes: number; tokens: number } | null {
  const inBody = JSON.stringify(trace.brief).slice(1, -1);
  const body = trace.bodies.find((b) => b.includes(inBody));
  if (body === undefined) return null;
  const bytes = Buffer.byteLength(body, 'utf8') - Buffer.byteLength(inBody, 'utf8');
  return { bytes, tokens: tokensOf(bytes) };
}

/** Замер по ключу: из кэша, иначе проба (и запись в кэш). Неудача названа, не «ноль». */
export async function baseContext(key: BaseKey, deps: BaseDeps): Promise<BaseOutcome> {
  const id = baseKeyId(key);
  const cache = await deps.read();
  if ('unknown' in cache) return { ok: false, reason: `base cache unreadable: ${cache.unknown}` };
  const file: BaseCacheFile = 'value' in cache ? cache.value : { version: 1, bases: {} };
  const hit = file.bases[id];
  if (hit) {
    const { measuredAt: _at, ...base } = hit;
    return { ok: true, base, measured: false };
  }
  let trace: ProbeTrace;
  try {
    trace = await deps.probe(key);
  } catch (error) {
    return { ok: false, reason: `base probe failed: ${String(error)}` };
  }
  const got = measureBase(trace);
  if (!got) return { ok: false, reason: 'base probe: no request carried the brief' };
  const base: BaseRecord = { ...key, ...got };
  file.bases[id] = { ...base, measuredAt: (deps.now ?? Date.now)() };
  await deps.write(file);
  return { ok: true, base, measured: true };
}

/** Забыть замер (дрейф): следующий старт с этим ключом меряет заново. */
export async function forgetBase(
  key: BaseKey,
  deps: Pick<BaseDeps, 'read' | 'write'>,
): Promise<boolean> {
  const cache = await deps.read();
  if (!('value' in cache)) return false;
  const id = baseKeyId(key);
  if (!cache.value.bases[id]) return false;
  const bases = { ...cache.value.bases };
  delete bases[id];
  await deps.write({ ...cache.value, bases });
  return true;
}

/**
 * Дрейф: вход первого живого хода (токены без вывода) против базы + брифа. Больше 20 % в любую
 * сторону — база устарела (новая версия CLI без смены номера, правка слоя мимо отпечатка).
 */
export function driftOf(
  base: Pick<BaseRecord, 'tokens'>,
  briefBytes: number,
  actualTokens: number,
): Drift {
  const expected = base.tokens + tokensOf(briefBytes);
  const ratio =
    expected === 0 ? (actualTokens === 0 ? 0 : 1) : Math.abs(actualTokens - expected) / expected;
  return { expected, actual: actualTokens, ratio, over: ratio > DRIFT_LIMIT };
}
