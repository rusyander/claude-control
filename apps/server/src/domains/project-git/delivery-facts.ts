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
 *   `refs/pull/<n>/head`) — тот же коммит, а ветка-источник — ветка группы.
 *   Ссылка из ответа агента берётся, только если её голова совпала; чужой MR с
 *   другой головой или другой веткой не засчитывается.
 */

/** Ключ задачи трекера в имени ветки: `GOR-1485`, `PROJ-1`. */
const TICKET_KEY = /[A-Z][A-Z0-9]+-\d+/g;

/** Ключ стоит в имени отдельно: не хвост другого ключа и не начало большего номера. */
function hasKey(name: string, key: string): boolean {
  return new RegExp(`(?<![A-Z0-9])${key}(?!\\d)`).test(name);
}

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
  /**
   * Ветка, которую группа завела и отправила сама вместо названной панелью, —
   * факты выше уже про неё. Нет — доставка по имени панели.
   */
  branch?: string;
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

/** Как выбрать MR группы из тех, чья голова совпала с копией. */
export interface DeliveredMrOptions {
  /** Ссылка из ответа агента — подсказка, не факт. */
  hint?: string;
  /** Ветка группы — та, чей MR ищется. */
  branch: string;
  /**
   * Ветка-источник MR по его адресу — у форджа. `undefined` — фордж не
   * подключён или не ответил: ветка неизвестна, а не другая.
   */
  branchOfMr?: (url: string) => Promise<string | undefined>;
  /**
   * Голова совпала с веткой, от которой копия отведена (предшественник): у
   * группы нет своих коммитов, и MR с этой головой — его, а не её.
   */
  sharedWithBase?: boolean;
}

/**
 * MR группы — MR её ветки, а не любой MR с той же головой (ревью разделения
 * 29.09: копия на голове предшественника подхватывала его MR). Кандидаты — MR,
 * чья голова `head`: сперва названный агентом (`hint`), потом остальные, из
 * нескольких — последний заведённый. Ветку-источник кандидата знает фордж — MR
 * чужой ветки не берётся. Без форджа ветку не узнать, и голова, общая с
 * основанием копии, MR не доказывает: он с тем же успехом предшественника.
 * Голова, совпавшая с HEAD удалённого (`main`), — MR без своих коммитов.
 */
export async function pickDeliveredMr(
  refs: Map<string, string>,
  head: string,
  base: string | undefined,
  options: DeliveredMrOptions,
): Promise<string | undefined> {
  if (refs.get('HEAD') === head) return undefined;
  const candidates: string[] = [];
  const { hint } = options;
  const hinted = hint ? mergeRequestRef(hint) : undefined;
  if (hint && hinted && refs.get(hinted) === head) candidates.push(hint);
  if (base) {
    const matching = [...refs]
      .filter(([ref, sha]) => sha === head && ref !== hinted && urlOfRef(ref, base))
      .map(([ref]) => ref)
      .sort((a, b) => Number(/\d+/.exec(b)?.[0] ?? 0) - Number(/\d+/.exec(a)?.[0] ?? 0));
    for (const ref of matching) {
      const url = urlOfRef(ref, base);
      if (url) candidates.push(url);
    }
  }
  for (const url of candidates) {
    const source = options.branchOfMr
      ? await options.branchOfMr(url).catch(() => undefined)
      : undefined;
    if (source !== undefined) {
      if (source === options.branch) return url;
      continue;
    }
    if (!options.sharedWithBase) return url;
  }
  return undefined;
}

export async function readDeliveryFacts(input: {
  cwd: string;
  branch: string;
  /** Ссылка на MR из ответа группы — подсказка, не факт. */
  mr?: string;
  mirror?: WorktreeMirrorSettings;
  /** Ветки других групп плана и основания копий: своей группе их не брать. */
  claimed?: readonly string[];
  /** Ветка, от которой отведена копия группы, — предшественник (ревью 29.09). */
  forkedFrom?: string;
  /** Ветка-источник MR у форджа; нет форджа — `undefined`. */
  branchOfMr?: (url: string) => Promise<string | undefined>;
}): Promise<DeliveryFacts> {
  const { cwd, branch } = input;
  const include = effectiveSettings(input.mirror).include;
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  const dirty = parseDirtyPaths(status).filter((path) => !listed(path, include));
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  // На какой ветке стоит копия: группа могла завести свою по правилу проекта
  // (живой прогон 29.09 — ключи через запятую вместо имени панели).
  const current = (
    await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  ).trim();
  const own = current && current !== branch ? current : undefined;

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
        ...(own ? [`refs/heads/${own}`] : []),
        ...(input.forkedFrom ? [`refs/heads/${input.forkedFrom}`] : []),
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
  // Свою ветку группы принимаем, только когда ветки панели на удалённом нет
  // вовсе, своя отправлена с головой копии, это не основная ветка удалённого и
  // в её имени есть ключ задачи из имени панели — целиком, а не как начало
  // большего номера (PROJ-12 не PROJ-123), и это не ветка другой группы плана и
  // не основание копии. Иначе копия, переключённая на develop или на ветку
  // предшественника с тем же ключом, увела бы группу на чужую ветку и чужой MR
  // (ревью 29.09). Ключа в имени панели нет — сверять не с чем, не берём.
  const keys = branch.match(TICKET_KEY) ?? [];
  const adopted =
    own &&
    keys.some((key) => hasKey(own, key)) &&
    !(input.claimed ?? []).includes(own) &&
    !refs.has(`refs/heads/${branch}`) &&
    refs.get(`refs/heads/${own}`) === head &&
    refs.get('HEAD') !== head
      ? own
      : undefined;
  const pushed = refs.get(`refs/heads/${adopted ?? branch}`) === head;
  const mr = await pickDeliveredMr(refs, head, base, {
    ...(input.mr ? { hint: input.mr } : {}),
    branch: adopted ?? branch,
    ...(input.branchOfMr ? { branchOfMr: input.branchOfMr } : {}),
    sharedWithBase: await sharesBaseHead(cwd, refs, head, input.forkedFrom, branch),
  });
  return { dirty, head, pushed, ...(mr ? { mr } : {}), ...(adopted ? { branch: adopted } : {}) };
}

/**
 * Голова копии — голова ветки, от которой её отвели: на удалённом или у
 * общего с другими копиями репозитория (ветку предшественника после слияния
 * MR на удалённом часто удаляют, а локально она остаётся).
 */
async function sharesBaseHead(
  cwd: string,
  refs: Map<string, string>,
  head: string,
  forkedFrom: string | undefined,
  branch: string,
): Promise<boolean> {
  if (!forkedFrom || forkedFrom === branch) return false;
  if (refs.get(`refs/heads/${forkedFrom}`) === head) return true;
  const local = await git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${forkedFrom}^{commit}`,
  ])
    .then((out) => out.trim())
    .catch(() => '');
  return local === head;
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
