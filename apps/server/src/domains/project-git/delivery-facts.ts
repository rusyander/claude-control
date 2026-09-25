import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import { serverText } from '../../lib/server-texts.ts';
import { git } from './exec.ts';
import { effectiveSettings, listed } from './mirror-local.ts';
import { mergeRequestRef, parseLsRemote } from './merge-request.ts';
import { pickRemote } from './parse.ts';
import { parseDirtyPaths } from './read.ts';

/**
 * Доставка группы по фактам git, а не по словам агента (живой прогон 24.09:
 * 97, 101, 108, 120 журнала — «готово» ставилось группам, у которых ветка не
 * была отправлена, MR не было или ссылка в ответе вела на чужой MR).
 *
 * Факты три, и каждый читается у git:
 * - дерево чистое — кроме того, что панель сама кладёт в копию зеркалом
 *   (`.mcp.json`, локальные настройки): это не работа группы;
 * - ветка на удалённом указывает на HEAD копии — `ls-remote`, не локальная
 *   ссылка отслеживания: та врёт, когда push ушёл в другое имя;
 * - есть MR, чья голова (`refs/merge-requests/<iid>/head`, у GitHub
 *   `refs/pull/<n>/head`) — тот же коммит. Ссылка из ответа агента берётся,
 *   только если её голова совпала; чужой MR с другой головой не засчитывается.
 */

/** Сетевой потолок одного `ls-remote`: чуть меньше, чем ждёт человек у хаба. */
const LS_REMOTE_TIMEOUT_MS = 30_000;

export interface DeliveryFacts {
  /** Незакоммиченное в копии, кроме зеркала панели. */
  dirty: string[];
  head?: string;
  /** Ветка на удалённом = HEAD копии. */
  pushed: boolean;
  /** MR, чья голова = HEAD копии. */
  mr?: string;
  /** Удалённый не ответил — факты сети неизвестны, а не отрицательны. */
  unreachable?: string;
}

/**
 * Чего не хватает до доставки — строками для группы и для хаба. Пусто — доставлено.
 * Строки — шаблоны сервера: их же читает агент в напоминании, а хаб по коду
 * показывает на языке интерфейса.
 */
export function missingDelivery(facts: DeliveryFacts, branch: string): string[] {
  if (facts.unreachable) return [];
  const missing: string[] = [];
  if (facts.dirty.length > 0) {
    const files = facts.dirty.slice(0, 5).join(', ');
    missing.push(
      facts.dirty.length > 5
        ? serverText('delivery-gap-dirty-more', { files, more: facts.dirty.length - 5 })
        : serverText('delivery-gap-dirty', { files }),
    );
  }
  if (!facts.pushed) missing.push(serverText('delivery-gap-not-pushed', { branch }));
  if (!facts.mr) missing.push(serverText('delivery-gap-no-mr', { branch }));
  return missing;
}

/**
 * Веб-адрес проекта по адресу удалённого: `git@host:group/app.git`,
 * `ssh://git@host:22/group/app.git`, `https://user@host/group/app.git` →
 * `https://host/group/app`. Не разобрать — `undefined`.
 */
export function webBaseOf(remoteUrl: string): string | undefined {
  const url = remoteUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const parsed = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
  if (parsed) return `https://${parsed[1]}/${parsed[2]}`;
  return undefined;
}

/** Адрес MR по его служебной ссылке и веб-адресу проекта. */
function urlOfRef(ref: string, base: string): string | undefined {
  const gitlab = /^refs\/merge-requests\/(\d+)\/head$/.exec(ref);
  if (gitlab) return `${base}/-/merge_requests/${gitlab[1]}`;
  const github = /^refs\/pull\/(\d+)\/head$/.exec(ref);
  if (github) return `${base}/pull/${github[1]}`;
  return undefined;
}

/**
 * MR, чья голова — `head`. Сперва названный агентом (`hint`), потом любой; из
 * нескольких — последний заведённый. Голова, совпавшая с HEAD удалённого
 * (`main`), MR группы не доказывает: это MR без своих коммитов.
 */
export function pickDeliveredMr(
  refs: Map<string, string>,
  head: string,
  base: string | undefined,
  hint?: string,
): string | undefined {
  if (refs.get('HEAD') === head) return undefined;
  const hinted = hint ? mergeRequestRef(hint) : undefined;
  if (hinted && refs.get(hinted) === head) return hint;
  if (!base) return undefined;
  const matching = [...refs]
    .filter(([ref, sha]) => sha === head && urlOfRef(ref, base))
    .map(([ref]) => ref)
    .sort((a, b) => Number(/\d+/.exec(b)?.[0] ?? 0) - Number(/\d+/.exec(a)?.[0] ?? 0));
  return matching[0] ? urlOfRef(matching[0], base) : undefined;
}

export async function readDeliveryFacts(input: {
  cwd: string;
  branch: string;
  /** Ссылка на MR из ответа группы — подсказка, не факт. */
  mr?: string;
  mirror?: WorktreeMirrorSettings;
}): Promise<DeliveryFacts> {
  const { cwd, branch } = input;
  const include = effectiveSettings(input.mirror).include;
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  const dirty = parseDirtyPaths(status).filter((path) => !listed(path, include));
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();

  const remote = pickRemote(await git(cwd, ['remote']));
  if (!remote) return { dirty, head, pushed: false };
  // Адрес как записан, без подстановок `insteadOf`: веб-адрес MR строится из
  // того, что знает человек, а не из зеркала, через которое ходит git.
  const base = webBaseOf(
    await git(cwd, ['config', '--get', `remote.${remote}.url`]).catch(() => ''),
  );

  let listing: string;
  try {
    listing = await git(
      cwd,
      [
        'ls-remote',
        remote,
        'HEAD',
        `refs/heads/${branch}`,
        'refs/merge-requests/*/head',
        'refs/pull/*/head',
      ],
      LS_REMOTE_TIMEOUT_MS,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { dirty, head, pushed: false, unreachable: reason.slice(0, 300) || remote };
  }
  const refs = parseLsRemote(listing);
  const pushed = refs.get(`refs/heads/${branch}`) === head;
  const mr = pickDeliveredMr(refs, head, base, input.mr);
  return { dirty, head, pushed, ...(mr ? { mr } : {}) };
}

/**
 * Описание MR — часть готовности (аудит 25.09, L110): MR с пустым описанием
 * «готовым» не считается. Читает фордж-клиент; MR не прочитать (интеграция
 * выключена, нет токена, фордж ответил ошибкой) — проверка пропускается, и
 * человеку говорится, что эту часть панель не проверила, а группа не держится.
 */
export async function mrDescriptionGap(
  mr: string,
  read: (url: string) => Promise<{ description?: string } | undefined>,
): Promise<{ missing?: string; unchecked?: true }> {
  const review = await read(mr).catch(() => undefined);
  if (!review || review.description === undefined) return { unchecked: true };
  return review.description.trim()
    ? {}
    : { missing: serverText('delivery-gap-mr-description', { mr }) };
}
