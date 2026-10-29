import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Profile } from '@agentdeck/contracts/core/records';
import {
  diskFree,
  diskVerdict,
  isTcc,
  memFree,
  memVerdict,
  realMachineIo,
  repoAccess,
} from '../../platform/machine.ts';
import type { MachineIo } from '../../platform/machine.types.ts';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { bindLoopback, type BindProbe } from '../../platform/ports.ts';
import { git } from '../../platform/git.ts';
import type { PreflightInput, PreflightProbes, RoadOutcome } from './preflight.types.ts';

/**
 * Пробы дорог, которые ядро умеет проверить само: диск, память, порты, доступ к папке
 * репозитория, `ls-remote` каждого удалённого. Пробы чужих зон (CLI, маршруты, MCP ядра, захват,
 * движок) приходят в `runPreflight` снаружи — их собирает сборка. Суждение «мало/много» здесь не
 * повторяется: его выносят `diskVerdict`/`memVerdict` (P01).
 */

const GiB = 1024 ** 3;

function gib(n: number): string {
  return `${(n / GiB).toFixed(1)} GB`;
}

export function diskProbe(path: string, io: MachineIo = realMachineIo) {
  return async (): Promise<RoadOutcome> => {
    const v = diskVerdict(await diskFree(path, io));
    if (v.kind === 'doubt')
      return { status: 'unknown', detail: `free disk unreadable: ${v.reason}` };
    if (v.kind === 'low')
      return {
        status: 'low',
        detail: `free disk ${gib(v.free.freeBytes)} below ${gib(v.thresholdBytes)}: no new copies or containers`,
        fix: `free space on the volume of ${path}`,
      };
    return { status: 'ok', detail: `free disk ${gib(v.free.freeBytes)}` };
  };
}

export function ramProbe(io: MachineIo = realMachineIo) {
  return async (): Promise<RoadOutcome> => {
    const v = memVerdict(memFree(io));
    if (v.kind === 'doubt')
      return { status: 'unknown', detail: `free memory unreadable: ${v.reason}` };
    if (v.kind === 'low')
      return {
        status: 'low',
        detail: `free memory ${gib(v.free.freeBytes)} below ${gib(v.thresholdBytes)}: session and check slots lowered`,
      };
    return { status: 'ok', detail: `free memory ${gib(v.free.freeBytes)}` };
  };
}

/** Настоящая привязка к 127.0.0.1:0 — та же, что выдаёт порты ядра (P59), а не проба «свободен ли». */
export function portsProbe(bind: BindProbe = bindLoopback) {
  return async (): Promise<RoadOutcome> => {
    try {
      const bound = await bind(0);
      await bound.close();
      return { status: 'ok', detail: `loopback bind ok (${bound.port})` };
    } catch (error) {
      return {
        status: 'fail',
        detail: `cannot bind 127.0.0.1: ${(error as Error).message}`,
        fix: 'allow loopback listening for node (firewall or security software)',
      };
    }
  };
}

export function repoAccessProbe(
  path: string,
  io: MachineIo = realMachineIo,
  os: OsKind = currentOs(),
) {
  return async (): Promise<RoadOutcome> => {
    const fact = await repoAccess(path, io, os);
    if ('value' in fact) return { status: 'ok' };
    if ('absent' in fact)
      return {
        status: 'fail',
        detail: `repository folder missing: ${path}`,
        fix: 'pick an existing repository folder',
      };
    if (isTcc(fact))
      return {
        status: 'unknown',
        detail: fact.unknown,
        fix: 'System Settings → Privacy & Security → Files and Folders (or Full Disk Access): allow the terminal/node',
      };
    return { status: 'unknown', detail: `repository folder unreadable: ${fact.unknown}` };
  };
}

export type LsRemote = (repo: string, remote: string) => Promise<Fact<{ code: number }>>;

/**
 * `git ls-remote` без вывода ссылок: ответ — дошёл ли git до удалённого и пустил ли он нас.
 * Адрес — после `--`: строка вида `--upload-pack=<команда>` иначе стала бы флагом, и git исполнил
 * бы команду от имени ядра.
 */
export const realLsRemote: LsRemote = async (repo, remote) => {
  try {
    const out = await git(repo, ['ls-remote', '--exit-code', '--heads', '--', remote], {
      timeoutMs: 20_000,
      acceptNonZero: true,
      extraEnv: { GIT_TERMINAL_PROMPT: '0' },
    });
    return { value: { code: out.code ?? -1 } };
  } catch (error) {
    return { unknown: (error as Error).message };
  }
};

export function lsRemoteProbe(
  repo: string,
  remotes: readonly string[],
  ls: LsRemote = realLsRemote,
) {
  return async (): Promise<RoadOutcome> => {
    if (remotes.length === 0) return { status: 'ok', detail: 'task has no remotes' };
    const answers = await Promise.all(remotes.map(async (r) => ({ r, fact: await ls(repo, r) })));
    const unknown = answers.filter((a) => 'unknown' in a.fact);
    // Код 2 у `--exit-code` — «ссылок нет» (пустой удалённый): дорога цела.
    const failed = answers.filter(
      (a) => 'value' in a.fact && a.fact.value.code !== 0 && a.fact.value.code !== 2,
    );
    if (failed.length > 0)
      return {
        status: 'fail',
        detail: `ls-remote refused: ${failed.map((a) => a.r).join(', ')}`,
        fix: 'check the remote URL and the git credentials for it',
      };
    if (unknown.length > 0)
      return {
        status: 'unknown',
        detail: `ls-remote gave no answer: ${unknown.map((a) => `${a.r} (${'unknown' in a.fact ? a.fact.unknown : ''})`).join(', ')}`,
      };
    return { status: 'ok', detail: `${remotes.length} remote(s) reachable` };
  };
}

/** Нужен ли движок контейнеров: рецепты сервисов или `needs` у проверок; профиль неизвестен — да. */
export function needsServicesOf(profile: Fact<Profile>): PreflightInput['needsServices'] {
  if (!('value' in profile)) return 'unknown';
  return (
    profile.value.serviceRecipes.length > 0 ||
    profile.value.registry.checks.some((c) => c.needs.length > 0)
  );
}

export interface PreflightRepo {
  path: string;
  /** Удалённые этого репозитория (имя или адрес); `ls-remote` идёт из его папки. */
  remotes: readonly string[];
}

export interface MachineProbeInput {
  /** Каждый репозиторий задачи (04:110, 04:132): доступ к папке и `ls-remote` — у каждого. */
  repos: readonly PreflightRepo[];
  /** Том, где ядро создаёт копии (дом ядра). */
  diskPath: string;
  io?: MachineIo;
  os?: OsKind;
  bind?: BindProbe;
  lsRemote?: LsRemote;
}

/**
 * Одна дорога по всем репозиториям: `fail` любого — `fail`, иначе не-`ok` любого — `unknown`
 * (исправление первого, у кого оно есть). Деталь называет репозиторий, когда их больше одного.
 */
function perRepo(
  repos: readonly PreflightRepo[],
  probe: (repo: PreflightRepo) => () => Promise<RoadOutcome>,
): () => Promise<RoadOutcome> {
  return async () => {
    if (repos.length === 0) return { status: 'unknown', detail: 'task names no repository' };
    const parts = await Promise.all(repos.map(async (r) => ({ r, out: await probe(r)() })));
    const named = (p: (typeof parts)[number]): string => {
      const detail = 'detail' in p.out && p.out.detail ? p.out.detail : p.out.status;
      return repos.length > 1 ? `${p.r.path}: ${detail}` : detail;
    };
    const fixOf = (ps: typeof parts): string | undefined =>
      ps.map((p) => ('fix' in p.out ? p.out.fix : undefined)).find((f) => f !== undefined);
    const failed = parts.filter((p) => p.out.status === 'fail');
    if (failed.length > 0) {
      return { status: 'fail', detail: failed.map(named).join('; '), fix: fixOf(failed) ?? '' };
    }
    const unread = parts.filter((p) => p.out.status !== 'ok');
    if (unread.length > 0) {
      const fix = fixOf(unread);
      return { status: 'unknown', detail: unread.map(named).join('; '), ...(fix ? { fix } : {}) };
    }
    return { status: 'ok', detail: parts.map(named).join('; ') };
  };
}

export function machineProbes(input: MachineProbeInput): PreflightProbes {
  const io = input.io ?? realMachineIo;
  return {
    disk: diskProbe(input.diskPath, io),
    ram: ramProbe(io),
    ports: portsProbe(input.bind),
    'repo-access': perRepo(input.repos, (r) => repoAccessProbe(r.path, io, input.os)),
    'ls-remote': perRepo(input.repos, (r) => lsRemoteProbe(r.path, r.remotes, input.lsRemote)),
  };
}
