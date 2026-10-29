import type { Fact } from '@agentdeck/contracts/core/facts';
import type { EngineInfo } from '@agentdeck/contracts/core/records';
import type { LiveTask } from '../../journal/resume.ts';
import {
  EPHEMERAL_LABEL,
  handleOf,
  listByLabels,
  removeCacheVolume,
  removeEphemeral,
  removePod,
  removeSessionContainer,
  type EngineHandle,
  type EngineRelease,
} from '../../platform/container-engine.ts';
import type { ProcessIdentity } from '../../platform/process-table.ts';
import {
  releasePort,
  releaseProcess,
  releaseTmp,
  releaseWorktree,
  type ReleaseResult,
} from '../../platform/resource-release.ts';
import { tcpOpen } from '../../platform/net-probe.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readHealth, type StandRegistry } from '../../verifier/stand/index.ts';
import { ActionFailed, runAction } from '../outbox.ts';
import {
  asServiceContainer,
  infoOfHint,
  parseRef,
  resourceRows,
  startHints,
  type CacheVolumeRef,
  type ContainerHint,
  type ResourceRow,
  type ServiceContainerRef,
  type StandRef,
} from './refs.ts';

/**
 * Снятие ресурсов (01 §Resources, P40, P90): каждое кончается чтением назад, «снято» — только
 * по нему. Команда человека `release-resource {rid}` (G25) снимает один ресурс любого вида,
 * у которого есть снятие; конец задачи снимает контейнеры сервисов ядра. Контейнер ядра
 * снимается действием outbox `container-remove` и только при совпадении меток (чужой — отказ,
 * не тронут).
 */

export interface ReleaseDeps {
  handle?: (info: EngineInfo) => Fact<EngineHandle>;
  stopProcess?: (id: ProcessIdentity) => Promise<ReleaseResult>;
  health?: (url: string) => Promise<Fact<number>>;
  /** Реестр стендов: снятый стенд снимается и с наблюдения (эпоха ключа сдвигается). */
  stands?: Pick<StandRegistry, 'detach'>;
}

export type ReleaseOutcome =
  | { rid: string; verified: string }
  | { rid: string; leak: string }
  | { rejected: 'no-such-resource' | 'already-released' | 'not-releasable'; reason: string };

/** Виды без снятия по команде: у них свои дороги (аренда, сессия копии, модели, переход). */
const RELEASERS = new Set(['tmpdir', 'copy', 'container', 'process', 'port', 'volume', 'stand']);

function fromEngine(r: EngineRelease): ReleaseResult {
  if ('refused' in r) return { leak: `refused: ${r.refused}` };
  return r;
}

async function releaseServiceContainer(
  task: LiveTask,
  ref: ServiceContainerRef,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  const h = (deps.handle ?? ((info) => handleOf(info)))(ref.engine);
  if (!('value' in h)) {
    return { leak: `engine ${ref.engine.cli}: ${'unknown' in h ? h.unknown : 'CLI not in PATH'}` };
  }
  const hint: ContainerHint = {
    labels: ref.labels,
    cli: ref.engine.cli,
    socket: ref.engine.socket,
  };
  const box: { got?: EngineRelease } = {};
  const done = await runAction(
    task,
    { kind: 'container-remove', target: ref.id, idempotencyHint: JSON.stringify(hint) },
    async () => {
      const got = await removeEphemeral(h.value, ref.id, ref.labels);
      box.got = got;
      if ('refused' in got) throw new ActionFailed('refused', got.refused);
      const fact: Record<string, string> =
        'verified' in got ? { verified: got.verified } : { leak: got.leak };
      return fact;
    },
  );
  if (!box.got) return { leak: done.ok ? 'no release result' : `container-remove ${done.code}` };
  return fromEngine(box.got);
}

/** Порт адреса здоровья: «не отвечает» — только отказ в соединении; таймаут и прочее не прочитаны. */
async function portRefused(url: string): Promise<{ refused: true } | { leak: string }> {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return { leak: `stand health ${url} is not a URL: nothing read back` };
  }
  const port = Number(at.port || (at.protocol === 'https:' ? 443 : 80));
  const host = at.hostname.replace(/^\[|\]$/g, '');
  const probe = await tcpOpen(host, port, 2_000);
  if (probe.open) return { leak: `stand ${url}: port still bound` };
  if (/ECONNREFUSED/.test(probe.reason)) return { refused: true };
  return { leak: `stand ${url}: port unread (${probe.reason})` };
}

async function releaseStand(
  task: LiveTask,
  ref: StandRef,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  deps.stands?.detach(ref.key ?? task.taskId);
  const stopped = await (deps.stopProcess ?? ((id) => releaseProcess(id)))({
    pid: ref.pid,
    start: ref.start,
  });
  if ('leak' in stopped) return stopped;
  // Процесс ушёл, а адрес отвечает — стенд держит кто-то ещё (дочерний сервер): не «снято».
  const after = await (deps.health ?? ((url) => readHealth(url)))(ref.health);
  if ('value' in after) return { leak: `stand ${ref.health} still answers ${after.value}` };
  // Непрочитанный ответ (таймаут зависшего сервера, мусорный адрес) — не «молчит»: снятым
  // считается только порт, отказавший в соединении (P44: unknown не становится зелёным).
  const port = await portRefused(ref.health);
  if ('leak' in port) return port;
  return { verified: `${stopped.verified}; ${ref.health} not answering` };
}

async function releaseVolume(ref: CacheVolumeRef, deps: ReleaseDeps): Promise<ReleaseResult> {
  const h = (deps.handle ?? ((info) => handleOf(info)))(ref.engine);
  if (!('value' in h)) return { leak: `engine ${ref.engine.cli}: CLI not usable` };
  return fromEngine(await removeCacheVolume(h.value, ref.name));
}

/**
 * Находка сессии (`{engine, id[, pod]}`): движок — CLI по имени из записи, метка задачи сверяется
 * до `rm -f` (ревью B2r2-F01: контейнер другой задачи, попавший в окно вызова, не снимается).
 */
async function releaseSessionRef(
  task: LiveTask,
  ref: { engine: string; id: string; pod?: unknown },
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  const cli = ref.engine === 'podman' ? 'podman' : 'docker';
  const info = {
    kind: cli,
    socket: '',
    composeV2: false,
    composeV1: false,
    cli,
    viaSocket: false,
    serverVersion: '',
    serverOs: '',
  } satisfies EngineInfo;
  const h = (deps.handle ?? ((i) => handleOf(i)))(info);
  if (!('value' in h)) {
    return { leak: `engine ${cli}: ${'unknown' in h ? h.unknown : 'CLI not in PATH'}` };
  }
  const got =
    ref.pod === true
      ? await removePod(h.value, ref.id, task.taskId)
      : await removeSessionContainer(h.value, ref.id, task.taskId);
  return fromEngine(got);
}

/** Снятие по виду записи. Запись зоны D (`{engine:'docker', id}`) и зоны F (`engine` объектом). */
export async function releaseByKind(
  task: LiveTask,
  row: Pick<ResourceRow, 'kind' | 'ref'>,
  deps: ReleaseDeps = {},
): Promise<ReleaseResult> {
  try {
    if (row.kind === 'tmpdir') return releaseTmp(row.ref);
    const v = parseRef(row.ref);
    if (!v) return { leak: `ref of ${row.kind} is not JSON` };
    switch (row.kind) {
      case 'copy':
        return await releaseWorktree(v as { worktree: string; repo: string });
      case 'container': {
        const own = asServiceContainer(row.ref);
        if (own) return await releaseServiceContainer(task, own, deps);
        return await releaseSessionRef(task, v as { engine: string; id: string }, deps);
      }
      case 'process':
        return await (deps.stopProcess ?? ((id) => releaseProcess(id)))(
          v as unknown as ProcessIdentity,
        );
      case 'port':
        return await releasePort(
          v as unknown as { address: string; port: number; owner: ProcessIdentity },
        );
      case 'volume':
        return await releaseVolume(v as unknown as CacheVolumeRef, deps);
      case 'stand':
        return await releaseStand(task, v as unknown as StandRef, deps);
      default:
        return { leak: `no release for kind ${row.kind}` };
    }
  } catch (error) {
    return { leak: error instanceof Error ? error.message : String(error) };
  }
}

function journalResult(task: LiveTask, rid: string, result: ReleaseResult): ReleaseOutcome {
  if ('verified' in result) {
    task.append({ kind: 'resource.verified', actor: 'core', data: { rid, fact: result.verified } });
    return { rid, verified: result.verified };
  }
  task.append({ kind: 'resource.leak', actor: 'core', data: { rid, reason: result.leak } });
  return { rid, leak: result.leak };
}

/**
 * Снятие одной строки ресурса концом задачи — одно на ядро (ревью A2r5-F09: дорога сессии
 * повторяла его строка в строку): подтверждённая или неизвестная строка не трогается (`null`),
 * живая получает `resource.released`, исход — `resource.verified` / `resource.leak`.
 */
export async function releaseRow(
  task: LiveTask,
  rid: string,
  release: () => Promise<ReleaseResult>,
): Promise<ReleaseOutcome | null> {
  const status = task.state.resources[rid]?.status;
  if (status === undefined || status === 'verified') return null;
  if (status === 'live') task.append({ kind: 'resource.released', actor: 'core', data: { rid } });
  return journalResult(task, rid, await release());
}

/** Команда `release-resource {rid}`: снять один ресурс и прочитать назад (P90). */
export async function releaseResource(
  task: LiveTask,
  rid: string,
  deps: ReleaseDeps = {},
): Promise<ReleaseOutcome> {
  const row = resourceRows(task).find((r) => r.rid === rid);
  const status = task.state.resources[rid]?.status;
  if (!row || !status) {
    return { rejected: 'no-such-resource', reason: `resource ${rid} not in this task` };
  }
  if (status === 'verified') {
    return {
      rejected: 'already-released',
      reason: `resource ${rid} already released and read back`,
    };
  }
  if (!RELEASERS.has(row.kind)) {
    return {
      rejected: 'not-releasable',
      reason: `${row.kind} is released by its own road, not by command`,
    };
  }
  if (status === 'live') task.append({ kind: 'resource.released', actor: 'core', data: { rid } });
  return journalResult(task, rid, await releaseByKind(task, row, deps));
}

/** Ресурс ядра, который снимает конец задачи: контейнер сервиса, стенд, том кэша. */
function releasedAtTaskEnd(row: ResourceRow): boolean {
  if (row.owner !== 'core' || row.release !== 'task-end') return false;
  if (row.kind === 'container') return asServiceContainer(row.ref) !== null;
  return row.kind === 'stand' || row.kind === 'volume';
}

/**
 * Контейнеры начатых `container-start` без строки ресурса (крах между `docker run` и записью,
 * незаписанный `action.done`): найдены по меткам и записаны, чтобы цикл снятия их снял.
 * Метки не прочитались — утечка с причиной: чистого конца задачи по непрочитанному нет.
 */
async function recordUnjournaled(task: LiveTask, deps: ReleaseDeps): Promise<ReleaseOutcome[]> {
  const out: ReleaseOutcome[] = [];
  const known = resourceRows(task)
    .map((row) => (row.kind === 'container' ? asServiceContainer(row.ref)?.id : undefined))
    .filter((id): id is string => id !== undefined);
  for (const { recipe, hint } of startHints(task)) {
    const info = infoOfHint(hint);
    const h = (deps.handle ?? ((i) => handleOf(i)))(info);
    const listed =
      'value' in h
        ? await listByLabels(h.value, { ...hint.labels, [EPHEMERAL_LABEL]: '1' })
        : { unknown: `engine ${hint.cli}: ${'unknown' in h ? h.unknown : 'CLI not in PATH'}` };
    if (!('value' in listed)) {
      const why = 'unknown' in listed ? listed.unknown : 'absent';
      out.push({ rid: `unread:${recipe}`, leak: `containers of ${recipe} unread: ${why}` });
      continue;
    }
    for (const { id } of listed.value) {
      if (known.some((k) => k === id || k.startsWith(id) || id.startsWith(k))) continue;
      known.push(id);
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: {
          rid: newId(),
          kind: 'container',
          owner: 'core',
          release: 'task-end',
          ref: JSON.stringify({ engine: info, id, recipe, port: null, labels: hint.labels }),
        },
      });
    }
  }
  return out;
}

/**
 * Конец задачи: ресурсы ядра с `release:'task-end'` (контейнеры сервисов, стенд, том), ещё не
 * подтверждённые снятыми, снимаются и читаются назад; утечка прошлого прохода пробуется снова;
 * контейнер без строки ресурса находится по меткам начатого запуска. Находки сессии снимает
 * дорога сессии (зона D), копии — дорога копий.
 */
export async function releaseServices(
  task: LiveTask,
  deps: ReleaseDeps = {},
): Promise<ReleaseOutcome[]> {
  const out: ReleaseOutcome[] = await recordUnjournaled(task, deps);
  for (const row of resourceRows(task)) {
    if (!releasedAtTaskEnd(row)) continue;
    const got = await releaseRow(task, row.rid, () => releaseByKind(task, row, deps));
    if (got) out.push(got);
  }
  return out;
}
