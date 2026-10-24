import type { ColdCacheRule } from '../watch/watch.types.ts';
import { foreignTranscriptKind } from './foreign-transcript.ts';
import type { ForeignTranscriptKind } from './foreign.types.ts';

/**
 * С какой паузы кэш чужого CLI считается остывшим (решение O4 плана, цены и
 * сроки провайдеров по знаниям, не по замеру): DashScope у Qwen Code — пять
 * минут, OpenAI у Codex — десять. Локальная модель кэша провайдера не платит —
 * продолжение у неё никогда не дороже нового разговора. Один срок на оба
 * решения: «начать новую сессию» (`foreign-cold`) и сигнал сторожа R2.
 */
export const FOREIGN_COLD_AFTER_MS: Readonly<Record<ForeignTranscriptKind, number>> = {
  qwen: 5 * 60_000,
  codex: 10 * 60_000,
};

/**
 * Чем переписка CLI выдаёт остывший кэш. Записи кэша ни Codex
 * (`cache_write_input_tokens` у OpenAI — 0), ни Qwen Code не сообщают, чтение
 * сообщают оба (`cached_input_tokens`, `cached_content_token_count`): след —
 * падение чтения после паузы.
 */
const COLD_SIGNAL: Readonly<Record<ForeignTranscriptKind, ColdCacheRule['kind']>> = {
  codex: 'readDrop',
  qwen: 'readDrop',
};

/**
 * Правило R2 для сессии чужого CLI: локальная модель и CLI без известного
 * формата переписки — без сигнала; иначе — свой срок провайдера (`coldAfterMs`
 * перекрывает его в проверках) и свой след.
 */
export function foreignColdRule(
  providerId: string,
  options: { local?: boolean; coldAfterMs?: number } = {},
): ColdCacheRule {
  const kind = foreignTranscriptKind(providerId);
  if (!kind || options.local || COLD_SIGNAL[kind] === 'off') return { kind: 'off' };
  return { kind: 'readDrop', afterMs: options.coldAfterMs ?? FOREIGN_COLD_AFTER_MS[kind] };
}
