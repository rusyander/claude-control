import type { ConfigView, CoreConfig } from '@agentdeck/contracts/core/config';
import type {
  McpOfferServer,
  McpOffersReply,
  McpPickKind,
} from '@agentdeck/contracts/core/panel-api';

/**
 * Выбор серверов MCP человека для задач ядра (`config.mcpPicks`, s10 p9): вид шага → имена
 * серверов. Ядро судит выбор по предложениям CLI сеанса при каждом запуске; экран показывает
 * предложения слоя пользователя (`GET /v1/mcp-offers`) и пишет весь раздел одной записью
 * `set-config` с отпечатком — чужая запись между чтением и сохранением даёт 409, а не затирание.
 */

/** Черновик: вид → выбранные имена; `null` — «все предложенные» (только вид `allByDefault`). */
export type PicksDraft = Record<string, string[] | null>;

export interface PickCliOffer {
  cli: string;
  scope: McpOfferServer['scope'];
  transport: McpOfferServer['transport'];
  skipped?: string;
}

export interface PickRow {
  id: string;
  /** Какие CLI предлагают сервер и как (у одного он может не переноситься — `skipped`). */
  offers: PickCliOffer[];
  /** Хоть один CLI переносит сервер (`transport` есть). */
  offered: boolean;
  /** Выбран в настройке, но ни один CLI его не предлагает: ядро выбросит его с причиной. */
  unknown: boolean;
}

/** Виды, которые берут серверы человека: только чтения ядро их не даёт (инструменты не прочитаны). */
export function pickKinds(reply: McpOffersReply): McpPickKind[] {
  return reply.kinds.filter((k) => k.takesHuman);
}

export function readOnlyKinds(reply: McpOffersReply): string[] {
  return reply.kinds.filter((k) => !k.takesHuman).map((k) => k.kind);
}

/** Черновик из действующей настройки: нет записи у вида «все по умолчанию» — `null`. */
export function draftOf(view: ConfigView | undefined, kinds: readonly McpPickKind[]): PicksDraft {
  const picks = view?.doc.mcpPicks ?? {};
  const draft: PicksDraft = {};
  for (const k of kinds) {
    const ids = picks[k.kind as keyof typeof picks];
    if (ids) draft[k.kind] = [...ids];
    else draft[k.kind] = k.allByDefault ? null : [];
  }
  return draft;
}

/** Строки экрана: серверы всех CLI по имени плюс выбранные, которых никто не предлагает. */
export function pickRows(reply: McpOffersReply, draft: PicksDraft): PickRow[] {
  const rows = new Map<string, PickRow>();
  for (const cli of reply.clis) {
    for (const s of cli.servers) {
      const row = rows.get(s.id) ?? { id: s.id, offers: [], offered: false, unknown: false };
      row.offers.push({
        cli: cli.cli,
        scope: s.scope,
        transport: s.transport,
        ...(s.skipped ? { skipped: s.skipped } : {}),
      });
      row.offered ||= s.transport !== null;
      rows.set(s.id, row);
    }
  }
  for (const ids of Object.values(draft)) {
    for (const id of ids ?? []) {
      if (!rows.has(id)) rows.set(id, { id, offers: [], offered: false, unknown: true });
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Отмечен ли сервер у вида: «все по умолчанию» отмечает каждый переносимый. */
export function isPicked(draft: PicksDraft, kind: string, row: PickRow): boolean {
  const ids = draft[kind];
  return ids === null ? row.offered : (ids ?? []).includes(row.id);
}

/**
 * Переключение одной отметки. Вид «все по умолчанию» при первой правке становится явным списком
 * из всех переносимых — иначе снятая отметка вернулась бы следующим же предложением.
 */
export function togglePick(
  draft: PicksDraft,
  kind: string,
  id: string,
  rows: readonly PickRow[],
): PicksDraft {
  const current = draft[kind] ?? rows.filter((r) => r.offered).map((r) => r.id);
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  return { ...draft, [kind]: next };
}

export function setAllByDefault(
  draft: PicksDraft,
  kind: string,
  on: boolean,
  rows: readonly PickRow[],
): PicksDraft {
  return { ...draft, [kind]: on ? null : rows.filter((r) => r.offered).map((r) => r.id) };
}

/**
 * Документ настройки с новым выбором. Пустой список у обычного вида — записи нет (по умолчанию
 * пусто); у вида «все по умолчанию» пустой список явный («ни одного»), `null` — записи нет.
 */
export function withPicks(
  view: ConfigView,
  draft: PicksDraft,
  kinds: readonly McpPickKind[],
): { doc: CoreConfig; baseDigest: string } {
  const picks: Record<string, string[]> = { ...(view.doc.mcpPicks ?? {}) } as Record<
    string,
    string[]
  >;
  for (const k of kinds) {
    const ids = draft[k.kind];
    if (ids === null || ids === undefined || (ids.length === 0 && !k.allByDefault)) {
      delete picks[k.kind];
    } else {
      picks[k.kind] = [...ids].sort();
    }
  }
  const doc: CoreConfig = { ...view.doc };
  if (Object.keys(picks).length > 0) doc.mcpPicks = picks as CoreConfig['mcpPicks'];
  else delete doc.mcpPicks;
  return { doc, baseDigest: view.digest };
}

/** Черновик отличается от действующей настройки — кнопка сохранения активна. */
export function draftChanged(
  view: ConfigView | undefined,
  draft: PicksDraft,
  kinds: readonly McpPickKind[],
): boolean {
  if (!view) return false;
  const before = JSON.stringify(withPicks(view, draftOf(view, kinds), kinds).doc.mcpPicks ?? {});
  const after = JSON.stringify(withPicks(view, draft, kinds).doc.mcpPicks ?? {});
  return before !== after;
}
