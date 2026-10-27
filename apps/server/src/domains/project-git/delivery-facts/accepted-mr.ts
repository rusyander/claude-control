import { TICKET_KEY, hasKey } from './delivery-facts.ts';

/**
 * MR группы, которую человек принял сам (`split-acceptance.ts`), когда панель его так и
 * не записала: доставка шла с пробелами, и до 24.10 ссылка из ответа группы уходила
 * только в хвост (`withoutMr`), а пауза до проверки доставки не оставляла и её. Копию
 * к приёмке обычно уже убрали — голову не сверить, и ссылку из ответа подтверждает
 * фордж: ветка-источник MR — ветка группы, или её собственная с ключом задачи из
 * имени панели и не чужая ветка плана (то же правило, что у `readDeliveryFacts`).
 * Фордж не ответил — ссылка не доказана и не берётся (g2/g6 плана d9869abf, 26.10).
 */

/** Последний адрес MR (GitLab `/-/merge_requests/N`, GitHub `/pull/N`) в тексте ответа. */
const MR_URL = /https?:\/\/[^\s<>()"'`]+?\/(?:-\/merge_requests|pull)\/\d+/g;

export function mrUrlIn(text: string | undefined): string | undefined {
  return text ? [...text.matchAll(MR_URL)].at(-1)?.[0] : undefined;
}

export interface AcceptedMrInput {
  /** Хвост ответа группы — там её ссылка на MR. */
  tail?: string;
  /** Ветка группы по имени панели. */
  branch: string;
  /** Ветки других групп плана и основания копий. */
  claimed: readonly string[];
  /** MR, уже записанные другим группам плана. */
  taken: readonly string[];
}

/** Ветка-источник MR — ветка группы: та же или своя с её ключом задачи. */
export function ownMrBranch(source: string, branch: string, claimed: readonly string[]): boolean {
  if (source === branch) return true;
  if (claimed.includes(source)) return false;
  return (branch.match(TICKET_KEY) ?? []).some((key) => hasKey(source, key));
}

export async function acceptedMrOf(
  input: AcceptedMrInput,
  branchOfMr: (url: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const url = mrUrlIn(input.tail);
  if (!url) return undefined;
  const same = (a: string): string => a.replace(/\/+$/, '').toLowerCase();
  if (input.taken.some((mr) => same(mr) === same(url))) return undefined;
  const source = await branchOfMr(url).catch(() => undefined);
  return source !== undefined && ownMrBranch(source, input.branch, input.claimed) ? url : undefined;
}
