import { CACHE_TTL_LONG_MS, RELATIVE_RATES } from '../cost.ts';
import type { KeepWarmDecision, KeepWarmInput, KeepWarmSkip } from './keep-warm.types.ts';

/**
 * Прогрев кэша припаркованной сессии (G8, порт решения панельного `keep-warm`): сессия, которая
 * ждёт человека или очередь, через час простоя теряет кэш, и её следующий ход переписывает всё
 * окно по цене записи. Один ход в эту же сессию с постоянным словом платформы на 50-й минуте
 * часа читает окно из кэша и продлевает срок. Только если переходник умеет продолжение, маршрут
 * открыт (в держащее или исчерпанное окно — никогда, P122) и пинг дешевле перезаписи. Исполняет
 * пинг проводка (зона W); здесь — решение и его числа.
 */

/** Пинг — когда возраст кэша дошёл до этой доли срока (50 минут из 60). */
export const KEEP_WARM_AT_SHARE = 50 / 60;
/** Сорвавшийся пинг повторяется не раньше чем через пять минут. */
export const KEEP_WARM_RETRY_MS = 5 * 60_000;
/** Пингов на одно ожидание: дольше трёх часов ждать дешевле с холодным кэшем. */
export const KEEP_WARM_MAX_PINGS = 3;
/** Выход ответа на пинг (одно слово) с запасом, токены. */
const PING_OUTPUT_TOKENS = 16;

/** Постоянное слово платформы: не задача, без инструментов. */
export const KEEP_WARM_WORD =
  'agentdeck keep-alive check, not a task: reply with exactly one word, "ok", and use no tools.';

export function decideKeepWarm(input: KeepWarmInput): KeepWarmDecision {
  const rates = input.rates ?? RELATIVE_RATES;
  const { session } = input;
  const ttl = session.cacheTtlMs;
  const age = session.lastTurnAt === null ? -1 : Math.max(0, input.now - session.lastTurnAt);
  const ctx = session.contextTokens;
  // Пинг читает окно и пишет одно слово; без пинга следующий ход перепишет окно по часовой цене.
  const pingCost = Math.round(ctx * rates.read + PING_OUTPUT_TOKENS * rates.output);
  const rewriteCost = Math.round(ctx * rates.write1h - ctx * rates.read);
  const numbers = {
    ageMs: age,
    ttlMs: ttl ?? -1,
    contextTokens: ctx,
    pingCost,
    rewriteCost,
    pings: input.pings.count,
  };
  const skip = (reason: KeepWarmSkip, why: string): KeepWarmDecision => ({
    kind: 'skip',
    reason,
    reasons: [why],
    numbers,
  });
  if (!session.parked) return skip('not-parked', 'a running turn keeps its own cache');
  if (!input.adapterResume)
    return skip('no-resume', 'the adapter declares no resume: a ping would be a fresh session');
  if (input.window === 'held' || input.window === 'exhausted')
    return skip('route-held', `route window ${input.window}: never pinged`);
  if (input.window !== 'open')
    return skip('route-not-open', `route window ${input.window ?? 'unknown'}: no ping`);
  if (session.lastTurnAt === null) return skip('no-turns', 'the session has no turn to keep warm');
  if (ttl === null) return skip('no-cache', 'the session writes no cache');
  if (ttl < CACHE_TTL_LONG_MS) return skip('ttl-short', 'a short cache dies before a ping pays');
  if (age >= ttl) return skip('cold', 'the cache has already expired');
  if (age < ttl * KEEP_WARM_AT_SHARE) return skip('not-yet', 'the cache is still young');
  if (input.pings.count >= KEEP_WARM_MAX_PINGS) return skip('cap', 'ping cap of this wait');
  if (input.pings.lastPingAt !== null && input.now - input.pings.lastPingAt < KEEP_WARM_RETRY_MS)
    return skip('not-yet', 'last ping too recent');
  if (pingCost >= rewriteCost)
    return skip('not-cheaper', `ping ${pingCost} is not cheaper than rewrite ${rewriteCost}`);
  return {
    kind: 'ping',
    word: KEEP_WARM_WORD,
    reasons: [
      `cache age ${Math.round(age / 60_000)} min of ${ttl / 60_000}: ping ${pingCost} < rewrite ${rewriteCost}`,
    ],
    numbers,
  };
}
