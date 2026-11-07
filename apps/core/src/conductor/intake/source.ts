import { createHash } from 'node:crypto';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { IntakeSource } from '@agentdeck/contracts/core/intake';
import type { SourcesRead } from './intake.types.ts';

/**
 * Источник задачи в теле оценки (W2-6). Поля оценки только расширяются, поэтому противоречие
 * «`source` и `sources` сразу» судит приём, а не схема. Тело снимка — данные: перед любым
 * использованием оно идёт под маску DLP (`registry.mask`), как и запрос.
 */

export function sourcesOf(fields: Pick<EstimateFields, 'source' | 'sources'>): SourcesRead {
  if (fields.source && fields.sources)
    return {
      ok: false,
      problem: 'source and sources: name one source or a list of sources, not both',
    };
  if (fields.source) return { ok: true, sources: [fields.source] };
  return { ok: true, sources: fields.sources ? [...fields.sources] : [] };
}

/**
 * Снимок под маской: тело, заголовок, критерии и ссылки — без секретов (P61: ни один сток не видит
 * их). Ссылки ложатся в строку решения `intake` как есть, а токен в адресе (`?private_token=`) —
 * обычное дело у трекеров. Поля трекера в журнал не идут (`sourceMetaOf` их снимает).
 */
export function maskedSource(source: IntakeSource, mask: (text: string) => string): IntakeSource {
  return {
    ...source,
    body: mask(source.body),
    // Ключ тоже текст трекера: он идёт в журнал (решение приёма) и в имя строки линта.
    ...(source.key !== undefined ? { key: mask(source.key) } : {}),
    ...(source.title !== undefined ? { title: mask(source.title) } : {}),
    ...(source.acceptance ? { acceptance: source.acceptance.map(mask) } : {}),
    ...(source.links
      ? {
          links: source.links.map((l) => ({
            url: mask(l.url),
            ...(l.title !== undefined ? { title: mask(l.title) } : {}),
          })),
        }
      : {}),
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Отпечаток карточки: один источник — его отпечаток; несколько — sha256 их отпечатков по порядку;
 * без источника (текст запроса) — sha256 запроса ПОД маской (открытый секрет не входит в хеш).
 */
export function sourceDigestOf(sources: readonly IntakeSource[], maskedRequest: string): string {
  if (sources.length === 1) return (sources[0] as IntakeSource).digest;
  if (sources.length > 1) return sha256(sources.map((s) => s.digest).join('\n'));
  return sha256(maskedRequest);
}

/** Структурные критерии всех источников по порядку (у текста и голоса их нет). */
export function structuredAcceptanceOf(sources: readonly IntakeSource[]): string[] {
  return sources.flatMap((s) => s.acceptance ?? []);
}

/** Трекер без снимка трекера: сценарий `tracker-ticket` (вторая версия) требует его. */
export function trackerSourceProblem(
  presetId: string,
  version: number,
  sources: readonly IntakeSource[],
): string | null {
  if (presetId !== 'tracker-ticket' || version < 2) return null;
  if (sources.some((s) => s.kind === 'tracker')) return null;
  return 'scenario tracker-ticket: needs a tracker snapshot in source (kind tracker) — the panel reads the ticket and sends its fields';
}
