import { findSecretSpans, maskSecretsInText, SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import type { Masked, Sink } from './sinks.types.ts';

/**
 * Одна маска на всех выходах к модели (P61): тот же детектор `@agentdeck/dlp`, что у журнала и
 * панели, с `keepHashes` — коммит и sha256 модели нужны, ключ — нет. `known` — значения, которые
 * ядро знает секретом по имени (окружение сеанса, ключ маршрута): детектор формы их может не
 * узнать (короткий пароль без префикса вендора), поэтому они прячутся по значению, до детектора.
 *
 * `sink` не меняет правило — он назван, чтобы каждый выход звал маску сам и тест мог убить её
 * на одном из них (мутант «нет маски на выходе»).
 */
const OPTIONS = { keepHashes: true } as const;
/** Короче — не секрет, а слово: замена по значению съела бы обычный текст. */
const KNOWN_MIN = 8;

export function maskSink(text: string, _sink: Sink, known: readonly string[] = []): Masked {
  let out = text;
  let masked = 0;
  for (const value of known) {
    if (value.length < KNOWN_MIN || !out.includes(value)) continue;
    const parts = out.split(value);
    masked += parts.length - 1;
    out = parts.join(SECRET_MASK);
  }
  const found = findSecretSpans(out, OPTIONS).length;
  if (found === 0) return { text: out, masked };
  return { text: maskSecretsInText(out, OPTIONS), masked: masked + found };
}
