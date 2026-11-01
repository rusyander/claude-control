/** Базовый контекст сеанса (G9): ключ, проба на заглушке, кэш, дрейф. */
export {
  baseContext,
  baseKeyId,
  BYTES_PER_TOKEN,
  DRIFT_LIMIT,
  driftOf,
  forgetBase,
  measureBase,
  setHash,
  tokensOf,
} from './base.ts';
export type {
  BaseCacheFile,
  BaseDeps,
  BaseKey,
  BaseOutcome,
  BaseRecord,
  Drift,
  ProbeTrace,
} from './base.types.ts';
