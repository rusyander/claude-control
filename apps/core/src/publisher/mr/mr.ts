import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeKind, ForgeMr, ForgePort } from '@agentdeck/contracts/core/forge';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { forgeActionKey, mrBodyHash } from '../../adapters/forge/index.ts';
import type { OutboxPort } from '../push/push.types.ts';

/**
 * MR единицы (05 §Push and MR, P31): личность MR — ТОЛЬКО id, который вернул форж на создание,
 * или чтение форжа по ветке + времени не раньше начала действия + своему аккаунту (после краха).
 * Никогда не разбор имени ветки и не догадка по голове. Создание и правка — через outbox.
 */

export type MrRecord = JournalDataV1['publish.mr'];

/** Запас на расхождение часов машины и форжа при поиске своего MR после краха. */
export const CREATED_SKEW_MS = 5 * 60_000;

export interface MrDeps {
  forge: ForgePort;
  forgeKind: ForgeKind;
  outbox: OutboxPort;
  /** Свой аккаунт форжа (`whoAmI`), прочитанный один раз за попытку. */
  self: string;
}

export interface MrInput {
  unitId: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft: boolean;
  /** Уже записанная личность MR единицы — её не заменяет ничто (P31). */
  existing: MrRecord | null;
  /** Незаконченные/неудачные `mr-create` этой единицы: самое раннее начало и id действия. */
  priorCreate: { actionId: string; startedAt: number } | null;
}

export type MrOutcome =
  | { kind: 'existing'; record: MrRecord }
  /** Найден по чтению форжа или создан — записать `publish.mr`. */
  | { kind: 'identified'; record: MrRecord; via: 'create' | 'read' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'unsupported'; reason: string };

function recordOf(forgeKind: ForgeKind, unitId: string, mr: ForgeMr, actionId: string): MrRecord {
  return {
    unitId,
    forge: forgeKind,
    mrId: mr.id,
    mrIid: mr.iid,
    url: mr.url,
    sourceBranch: mr.sourceBranch,
    actionId,
  };
}

function why<T>(fact: Fact<T>): string {
  return 'unknown' in fact ? fact.unknown : 'absent';
}

export async function ensureMr(deps: MrDeps, input: MrInput): Promise<MrOutcome> {
  if (input.existing) return { kind: 'existing', record: input.existing };
  if (input.priorCreate) {
    // Создание уже начиналось: сначала прочитать форж — второй MR на ту же ветку хуже ожидания.
    const found = await deps.forge.mrBySourceBranch({
      sourceBranch: input.sourceBranch,
      createdAfter: input.priorCreate.startedAt - CREATED_SKEW_MS,
      author: deps.self,
    });
    if ('value' in found) {
      return {
        kind: 'identified',
        record: recordOf(deps.forgeKind, input.unitId, found.value, input.priorCreate.actionId),
        via: 'read',
      };
    }
    if (!('absent' in found)) return { kind: 'unknown', reason: `mr by branch: ${why(found)}` };
  }
  const key = forgeActionKey({
    kind: 'mr-create',
    url: input.url,
    sourceBranch: input.sourceBranch,
    bodyHash: mrBodyHash(input.title, input.body),
  });
  // Ящик, а не `let`: эффект заполняет его внутри outbox, сужение типов замыкание не видит.
  const box: { created: ForgeMr | null; unsupported: string | null } = {
    created: null,
    unsupported: null,
  };
  const got = await deps.outbox.run({ kind: 'mr-create', ...key }, async () => {
    const res = await deps.forge.createMr({
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    if ('value' in res) {
      box.created = res.value;
      return { ok: true, result: { mrId: res.value.id, mrIid: res.value.iid, url: res.value.url } };
    }
    if ('unsupported' in res) {
      box.unsupported = res.unsupported;
      return { ok: false, code: 'unsupported', detail: res.unsupported };
    }
    return { ok: false, code: 'forge-unknown', detail: res.unknown };
  });
  if (got.ok && box.created) {
    return {
      kind: 'identified',
      record: recordOf(deps.forgeKind, input.unitId, box.created, got.actionId),
      via: 'create',
    };
  }
  if (box.unsupported !== null) return { kind: 'unsupported', reason: box.unsupported };
  return { kind: 'unknown', reason: got.ok ? 'create returned no MR' : got.code };
}

/**
 * Тело MR уже записанного: другое (MR соседней единицы появился, P76) — правка через outbox
 * `mr-update` с хешем нового тела. То же — ничего.
 */
export async function syncMrBody(
  deps: Pick<MrDeps, 'forge' | 'outbox'>,
  input: { url: string; iid: number; title: string; body: string },
): Promise<'same' | 'updated' | { unknown: string }> {
  const now = await deps.forge.mr(input.iid);
  if (!('value' in now)) return { unknown: `mr ${input.iid}: ${why(now)}` };
  const hash = mrBodyHash(input.title, input.body);
  if (now.value.bodyHash === hash) return 'same';
  const key = forgeActionKey({ kind: 'mr-update', url: input.url, iid: input.iid, bodyHash: hash });
  const got = await deps.outbox.run({ kind: 'mr-update', ...key }, async () => {
    const res = await deps.forge.updateMr(input.iid, { title: input.title, body: input.body });
    if ('value' in res) return { ok: true, result: { mrIid: input.iid, bodyHash: hash } };
    const detail = 'unsupported' in res ? res.unsupported : res.unknown;
    return { ok: false, code: 'unsupported' in res ? 'unsupported' : 'forge-unknown', detail };
  });
  return got.ok ? 'updated' : { unknown: got.code };
}
