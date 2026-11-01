import { enforceBudget, orderParts, renderPart } from '../brief/brief.ts';
import type { BriefPart, SentSection } from '../brief/brief.types.ts';
import type { Delta, SentSet } from './sent.types.ts';

/**
 * Набор отданного и дельта возобновления (03 §Context, P13): секция, уже отданная этой сессии с
 * тем же отпечатком, второй раз не уходит — ни часть брифа, ни правила, что вкладывает ядро
 * (`reminder`). Изменённая уходит сообщением с меткой платформы, целиком заменяя прежнюю: модель
 * видит, что это не слова человека и что старую версию надо забыть (порт `workspace-note`).
 *
 * Отпечаток — того, что увидела модель (блок под маской), а не исходного текста: перемена,
 * которую маска делает невидимой, модели не новость.
 */

export const DELTA_TAG = 'agentdeck-update';

/** Набор после отправки: последняя версия каждой секции (то же правило, что у свёртки v7). */
export function sentAfter(sent: SentSet, sections: readonly SentSection[]): Record<string, string> {
  const out: Record<string, string> = { ...sent };
  for (const s of sections) out[s.id] = s.sha256;
  return out;
}

/**
 * Дельта для сессии, которой уже отдан набор `sent`; `null` — ничего не изменилось, сообщения нет.
 * Бюджет корзин и итога — тот же, что у брифа (`BriefOverBudget`), на подмножестве секций.
 */
export function deltaOf(
  sent: SentSet,
  parts: readonly BriefPart[],
  stepKind: string,
  known: readonly string[] = [],
): Delta | null {
  const rendered = orderParts(parts).map((p) => renderPart(p, 'delta', known));
  const changed = rendered.filter((p) => sent[p.id] !== p.sha256);
  const kept = rendered.filter((p) => sent[p.id] === p.sha256).map((p) => p.id);
  if (changed.length === 0) return null;
  enforceBudget(changed, stepKind);
  const head =
    `<${DELTA_TAG}>Platform update, not a human message: ${changed.length} section(s) changed since ` +
    `your last turn (${changed.map((p) => p.id).join(', ')}). Each replaces the section of the ` +
    `same name you already have; sections not listed are unchanged.</${DELTA_TAG}>`;
  return {
    text: [head, ...changed.map((p) => p.block)].join('\n\n'),
    sections: changed.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })),
    kept,
    masked: changed.reduce((sum, p) => sum + p.masked, 0),
  };
}
