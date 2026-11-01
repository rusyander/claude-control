import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeActivity, ForgePort } from '@agentdeck/contracts/core/forge';
import { parseForgeActionKey } from '../../adapters/forge/index.ts';
import { remoteRefsKey } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { CLOSED_PUSH_URL } from '../../lib/publish-alias.ts';
import type {
  ForgedPublishInput,
  JournaledForgeEvent,
  RemoteRefsInput,
} from '../../observer/forged-publish.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { lsRemote } from '../../platform/git/ls-remote.ts';
import { readClosureState } from '../../platform/git/push-closure.ts';
import { unitReach } from '../../platform/git/unit-reach.ts';
import { configValues, remotesOfCopy } from '../../platform/git/worktree-config.ts';

/**
 * Факты суда `forged-publish` для одной единицы (05 §Push closure, G7): ссылки каждого remote
 * копии, достижимость их новых sha, состояние закрытия, события форжа своей учётки. Каждый факт —
 * `Fact`: непрочитанное уходит в суд как `unknown` и становится сигналом `warn`, а не «чисто».
 */

export interface GuardFactDeps {
  git: GitOptions;
  /** Порт форжа по адресу remote; `null` — форжа нет (чужой хост): событий не спрашивают. */
  forgeFor: (url: string) => ForgePort | null;
}

export interface GuardScope {
  task: LiveTask;
  unitId: string;
  copyDir: string;
  hooksDir: string;
  /** Конец шага — все remote; начало — только те, у кого уже есть база (первый шаг не судят). */
  mode: 'pre' | 'post';
  window: { from: number; to: number };
}

/**
 * Ссылки, которые двигает сам форж (`refs/merge-requests/*`, `refs/pull/*`, конвейеры) и
 * очищенные теги `^{}`: в базу не идут — каждая строка журнала их переписывала бы на каждом шаге.
 */
const FORGE_OWNED = ['refs/merge-requests/', 'refs/pull/', 'refs/pipelines/', 'refs/keep-around/'];

export function pushableRefs(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(all).filter(
      ([ref]) => !ref.endsWith('^{}') && !FORGE_OWNED.some((p) => ref.startsWith(p)),
    ),
  );
}

/** Пустой remote — `absent` у `ls-remote` без имён ссылок не бывает, но «нет ссылок» — значение. */
function remoteNow(read: Fact<Record<string, string>>): Fact<Record<string, string>> {
  if ('value' in read) return { value: pushableRefs(read.value) };
  return 'absent' in read ? { value: {} } : read;
}

const valueOr = <T>(fact: Fact<T>, fallback: T): T => ('value' in fact ? fact.value : fallback);

/** Адреса remote, по которым публикатор мог пушить: `url` и настоящие `pushurl` (не заглушка). */
async function remoteUrls(copy: string, remote: string, git: GitOptions): Promise<string[]> {
  const url = valueOr(await configValues(copy, `remote.${remote}.url`, 'effective', git), []);
  const push = valueOr(await configValues(copy, `remote.${remote}.pushurl`, 'effective', git), []);
  return [...url, ...push].filter((u) => u !== CLOSED_PUSH_URL);
}

/** Действие не провалилось — его эффект мог дойти; провал записан — эффекта нет. */
const mayHaveLanded = (status: string): boolean => status !== 'failed';

function journaled(task: LiveTask, unitId: string, urls: Record<string, string[]>) {
  const pushes: ForgedPublishInput['journaledPushes'] = [];
  const forge: JournaledForgeEvent[] = [];
  const remoteOf = (url: string): string =>
    Object.entries(urls).find(([, list]) => list.includes(url))?.[0] ?? '';
  for (const a of Object.values(task.state.actions)) {
    if (!mayHaveLanded(a.status) || (a.unitId !== undefined && a.unitId !== unitId)) continue;
    if (
      a.kind !== 'push' &&
      a.kind !== 'ref-delete' &&
      a.kind !== 'mr-create' &&
      a.kind !== 'mr-update' &&
      a.kind !== 'thread-reply'
    )
      continue;
    const key = parseForgeActionKey(a.kind, a.target, a.idempotencyHint);
    if (!key) continue;
    const short = (ref: string) => (ref.startsWith('refs/heads/') ? ref.slice(11) : ref);
    if (key.kind === 'push') {
      pushes.push({ remote: remoteOf(key.url), ref: key.ref, sha: key.sha });
      forge.push({ type: 'push', ref: short(key.ref) });
    } else if (key.kind === 'ref-delete')
      forge.push({ type: 'branch-delete', ref: short(key.ref) });
    else if (key.kind === 'mr-create') forge.push({ type: 'mr-open', ref: key.sourceBranch });
    else if (key.kind === 'mr-update') forge.push({ type: 'mr-update', mrIid: key.iid });
    else forge.push({ type: 'note', mrIid: key.iid });
  }
  const mr = Object.hasOwn(task.state.publication, unitId)
    ? task.state.publication[unitId]?.mr
    : null;
  // Открытие MR журнал знает по ветке; событие форжа называет его номером — оба ключа.
  if (mr) forge.push({ type: 'mr-open', mrIid: mr.mrIid });
  return { pushes, forge, mrIid: mr?.mrIid ?? null };
}

async function forgeFacts(
  scope: GuardScope,
  branch: string,
  mrIid: number | null,
  ports: ForgePort[],
): Promise<{ account: string | null; forge: Fact<ForgeActivity[]> | null }> {
  if (ports.length === 0) return { account: null, forge: null };
  // Один форж на задачу — обычный случай; второй порт того же хоста ничего нового не скажет.
  const port = ports[0]!;
  const me = await port.whoAmI();
  if (!('value' in me))
    return {
      account: '',
      forge: { unknown: `account: ${'unknown' in me ? me.unknown : 'absent'}` },
    };
  const account = me.value.username;
  // MR, открытый из ветки единицы мимо ядра, журналу неизвестен: его номер находит форж, иначе
  // лента событий (она отбирает по ветке и номерам) его открытия не покажет.
  const opened = await port.mrBySourceBranch({
    sourceBranch: branch,
    createdAfter: scope.window.from,
    author: account,
  });
  if ('unknown' in opened)
    return { account, forge: { unknown: `MR of ${branch}: ${opened.unknown}` } };
  const iids = new Set<number>(mrIid === null ? [] : [mrIid]);
  if ('value' in opened) iids.add(opened.value.iid);
  const events = await port.activitySince({
    since: scope.window.from,
    refs: [branch],
    mrIids: [...iids],
  });
  return { account, forge: 'absent' in events ? { value: [] } : events };
}

/** Собрать вход суда; ссылки «после» отдаются и вызывающему — он пишет из них новую базу. */
export async function gatherForged(
  scope: GuardScope,
  deps: GuardFactDeps,
): Promise<{ input: ForgedPublishInput; after: Record<string, Record<string, string>> }> {
  const { task, unitId, copyDir } = scope;
  const remotesFact = await remotesOfCopy(copyDir, deps.git);
  const remotes = valueOr(remotesFact, []);
  const urls: Record<string, string[]> = {};
  const refs: RemoteRefsInput[] = [];
  const after: Record<string, Record<string, string>> = {};
  if (!('value' in remotesFact))
    refs.push({
      remote: '*',
      before: {},
      after: {
        unknown: `git remote: ${'unknown' in remotesFact ? remotesFact.unknown : 'absent'}`,
      },
    });
  for (const remote of remotes) {
    urls[remote] = await remoteUrls(copyDir, remote, deps.git);
    const key = remoteRefsKey(task.state.units[unitId]?.repoKey, remote);
    const base = Object.hasOwn(task.state.remoteRefs, key)
      ? (task.state.remoteRefs[key]?.refs ?? null)
      : null;
    const now = remoteNow(await lsRemote(copyDir, remote, [], deps.git));
    if ('value' in now) after[remote] = now.value;
    // Начало первого шага: базы ещё нет — сравнивать не с чем, прочитанное станет базой.
    if (scope.mode === 'pre' && base === null) continue;
    refs.push({ remote, before: base, after: now });
  }
  const mine = journaled(task, unitId, urls);
  const candidates = new Set<string>();
  for (const r of refs) {
    if (!('value' in r.after) || r.before === null) continue;
    for (const [ref, sha] of Object.entries(r.after.value))
      if (r.before[ref] !== sha) candidates.add(sha);
  }
  const known = refs.flatMap((r) => Object.values(r.before ?? {}));
  const unitShas = await unitReach(copyDir, [...candidates], known, deps.git);
  const closureNow = await readClosureState(copyDir, scope.hooksDir, deps.git);
  const ports = Object.values(urls)
    .map((list) => (list[0] ? deps.forgeFor(list[0]) : null))
    .filter((p): p is ForgePort => p !== null);
  const branch = task.state.units[unitId]?.branch ?? '';
  const { account, forge } = await forgeFacts(scope, branch, mine.mrIid, ports);
  const closure = Object.hasOwn(task.state.closures, unitId)
    ? (task.state.closures[unitId] ?? null)
    : null;
  return {
    input: {
      subject: unitId,
      refs,
      unitShas,
      journaledPushes: mine.pushes,
      closure: closure && {
        unitId: closure.unitId,
        copyDir: closure.copyDir,
        pushurls: closure.pushurls,
        hooksPath: closure.hooksPath,
        hooksDirFp: closure.hooksDirFp,
        commonAliases: closure.commonAliases,
      },
      closureNow,
      account,
      forge,
      journaledForge: mine.forge,
      window: scope.window,
    },
    after,
  };
}
