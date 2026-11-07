import {
  INTAKE_BODY_MAX,
  INTAKE_SOURCES_MAX,
  type IntakeSource,
} from '@agentdeck/contracts/core/intake';
import type { ItemsAs, LaunchDraft, SourceDraft, SourceItemDraft } from './launch.types';

/**
 * Источник задачи на форме запуска (этап 11, P133, W3-16). Текст — по умолчанию: требования и
 * есть источник, отдельного поля нет. Задача трекера — снимок, который прочитала панель (ядро в
 * трекер не ходит). Голос — расшифровка диктовки в поле требований. Несколько пунктов — `sources[]`:
 * «одной задачей» (по умолчанию) — пункты текста, ядро разбирает их вместе; «группой» — каждый
 * пункт видом `group-item`, ядро ставит задачу на пункт с общим `groupId`. Отпечаток считается при
 * отправке, время снимка хранится в черновике с его правкой — тот же черновик даёт те же поля.
 */

export const SOURCE_MODES = ['text', 'tracker', 'voice', 'items'] as const;
export const ITEMS_AS: readonly ItemsAs[] = ['one', 'group'];

export function emptySource(): SourceDraft {
  return {
    mode: 'text',
    trackerKey: '',
    snapshot: null,
    voiceAt: null,
    items: [],
    itemsAs: 'one',
  };
}

export const emptyItem = (at: number): SourceItemDraft => ({ title: '', body: '', at });

type Content = Omit<IntakeSource, 'fetchedAt' | 'digest'>;

/** sha256 содержимого источника — тот же порядок полей, что у снимка трекера на сервере. */
export async function sourceDigest(source: Content): Promise<string> {
  const canonical = JSON.stringify([
    source.kind,
    source.key ?? null,
    source.title ?? null,
    source.body,
    source.fields ?? null,
    source.acceptance ?? null,
    source.links ?? null,
  ]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function frozen(content: Content, fetchedAt: number): Promise<IntakeSource> {
  return { ...content, fetchedAt, digest: await sourceDigest(content) };
}

export type SourceProblem = 'tracker-unread' | 'items-empty';

export interface SourceFields {
  source?: IntakeSource;
  sources?: IntakeSource[];
}

/** Поля источника оценки из черновика; нечего отправить — проблема, которую назовёт форма. */
export async function sourceFieldsOf(
  draft: LaunchDraft,
): Promise<{ ok: true; fields: SourceFields } | { ok: false; problem: SourceProblem }> {
  const src = draft.source;
  switch (src.mode) {
    case 'text':
      return { ok: true, fields: {} };
    case 'tracker':
      return src.snapshot
        ? { ok: true, fields: { source: src.snapshot } }
        : { ok: false, problem: 'tracker-unread' };
    case 'voice': {
      const body = draft.request.trim().slice(0, INTAKE_BODY_MAX);
      if (!body) return { ok: true, fields: {} };
      return {
        ok: true,
        fields: { source: await frozen({ kind: 'voice', body }, src.voiceAt ?? 0) },
      };
    }
    case 'items': {
      const filled = src.items.filter((i) => i.body.trim()).slice(0, INTAKE_SOURCES_MAX);
      if (filled.length === 0) return { ok: false, problem: 'items-empty' };
      // Вид один на все пункты: смесь пунктов группы с другими ядро отвергает целиком.
      const kind = src.itemsAs === 'group' ? 'group-item' : 'text';
      const sources = await Promise.all(
        filled.map((item) => {
          const title = item.title.trim().slice(0, 300);
          return frozen(
            {
              kind,
              ...(title ? { title } : {}),
              body: item.body.trim().slice(0, INTAKE_BODY_MAX),
            },
            item.at,
          );
        }),
      );
      return { ok: true, fields: { sources } };
    }
  }
}

/**
 * Требования, когда человек их не набрал: тело источника (у пунктов — тела подряд). Схема оценки
 * требует непустые требования, а у источника они и есть его тело.
 */
export function requestFallback(fields: SourceFields): string {
  const all = fields.sources ?? (fields.source ? [fields.source] : []);
  const text = all
    .map((s) => s.body || s.title || s.key || '')
    .filter(Boolean)
    .join('\n\n');
  return text.slice(0, INTAKE_BODY_MAX);
}

const filledTitle = (snapshot: IntakeSource): string => snapshot.title ?? snapshot.key ?? '';

/**
 * Снять снимок с черновика. Название и требования, которые заполнил он и которые человек не
 * правил, уходят вместе с ним: иначе другой ключ оставил бы в форме текст прежней задачи, и
 * оценка ушла бы со снимком одной задачи и требованиями другой.
 */
function withoutSnapshot(draft: LaunchDraft): LaunchDraft {
  const old = draft.source.snapshot;
  if (!old) return draft;
  return {
    ...draft,
    title: draft.title === filledTitle(old) ? '' : draft.title,
    request: draft.request === old.body ? '' : draft.request,
    source: { ...draft.source, snapshot: null },
  };
}

/** Новый ключ трекера: снимок прежнего ключа к нему не относится. */
export function withTrackerKey(draft: LaunchDraft, trackerKey: string): LaunchDraft {
  return withoutSnapshot({ ...draft, source: { ...draft.source, trackerKey } });
}

/**
 * Снимок трекера прочитан — пустые название и требования формы берутся из него. `requested` —
 * ключ, по которому шло чтение: ключ сменился до ответа — ответ опоздал и под новый ключ не
 * ложится (иначе в оценку ушёл бы снимок чужой задачи).
 */
export function withSnapshot(
  draft: LaunchDraft,
  snapshot: IntakeSource,
  requested: string,
): LaunchDraft {
  if (draft.source.trackerKey.trim() !== requested) return draft;
  const clean = withoutSnapshot(draft);
  return {
    ...clean,
    title: clean.title.trim() ? clean.title : filledTitle(snapshot),
    request: clean.request.trim() ? clean.request : snapshot.body,
    source: { ...clean.source, snapshot },
  };
}
