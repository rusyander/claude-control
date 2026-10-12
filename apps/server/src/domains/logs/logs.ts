import type { LogSource, LogsChunk, LogsSources } from '@agentdeck/contracts';
import { findComposeFile, type DockerExec } from '../compose/compose.ts';
import { shortDetail } from '../compose/docker.ts';
import { parsePs } from '../compose/parse.ts';
import type { RunLog } from '../project-runner/log-buffer.ts';
import { COMPOSE_CATCH_UP, COMPOSE_TAIL, afterCursor, parseComposeLogs } from './compose-logs.ts';

export { parseComposeLogs, afterCursor, timeKey } from './compose-logs.ts';

/**
 * Вкладка «Логи»: вывод целей «Dev-сервера» (буфер панели) и сервисов Compose
 * (сам docker, на каждый опрос) одним списком источников. Своего хранилища у
 * логов нет: цель помнит реестр запусков, сервис — docker.
 */
export interface LogsDeps {
  /** Цели проекта с выводом — `ProjectRunnerRegistry.logsOf`. */
  runs: (projectPath: string) => RunLog[];
  exec: DockerExec;
}

export type LogsErrorKind = 'unknown-source' | 'docker';

export class LogsError extends Error {
  readonly kind: LogsErrorKind;
  readonly detail?: string;
  constructor(kind: LogsErrorKind, message: string, detail?: string) {
    super(message);
    this.kind = kind;
    if (detail) this.detail = detail;
  }
}

const runId = (dir: string): string => `run:${dir}`;

interface ComposeServiceRow {
  service: string;
  state: string;
}

async function composeServices(
  root: string,
  exec: DockerExec,
): Promise<{
  docker: LogsSources['docker'];
  dir?: string;
  file?: string;
  rows: ComposeServiceRow[];
}> {
  const location = findComposeFile(root);
  if (!location) return { docker: 'none', rows: [] };
  const ps = await exec(['compose', 'ps', '--all', '--format', 'json'], location.dir, 20_000);
  if (ps.missing) return { docker: 'missing', file: location.file, rows: [] };
  if (ps.code !== 0) return { docker: 'stopped', dir: location.dir, file: location.file, rows: [] };
  let rows: ComposeServiceRow[];
  try {
    rows = parsePs(ps.stdout).map((row) => ({ service: row.service, state: row.state }));
  } catch {
    rows = [];
  }
  // Реплики одного сервиса — один источник: docker отдаёт их логи вместе.
  const unique = new Map<string, ComposeServiceRow>();
  for (const row of rows) if (!unique.has(row.service)) unique.set(row.service, row);
  return { docker: 'ok', dir: location.dir, file: location.file, rows: [...unique.values()] };
}

export async function listLogSources(root: string, deps: LogsDeps): Promise<LogsSources> {
  const runs: LogSource[] = deps.runs(root).map((run) => ({
    id: runId(run.dir),
    kind: 'run',
    label: run.name,
    state: run.state,
    detail: run.command,
  }));
  const compose = await composeServices(root, deps.exec);
  const services: LogSource[] = compose.rows.map((row) => ({
    id: `compose:${row.service}`,
    kind: 'compose',
    label: row.service,
    state: row.state,
  }));
  const all: LogSource[] =
    services.length > 1 ? [{ id: 'compose:*', kind: 'compose', label: '*', state: 'running' }] : [];
  return {
    sources: [...runs, ...all, ...services],
    docker: compose.docker,
    ...(compose.file ? { composeFile: compose.file } : {}),
  };
}

function readRun(root: string, dir: string, cursor: string | undefined, deps: LogsDeps): LogsChunk {
  const run = deps.runs(root).find((item) => item.dir === dir);
  if (!run) throw new LogsError('unknown-source', `Цель «${dir}» не запускалась`);
  const [startedAt, seqText] = (cursor ?? '').split('#');
  const same = startedAt === run.startedAt && /^\d+$/.test(seqText ?? '');
  const after = same ? Number(seqText) : 0;
  const { lines, last, truncated } = run.log.since(after);
  return {
    lines,
    cursor: `${run.startedAt}#${last}`,
    ...(cursor && !same ? { reset: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(run.state === 'stopped' || run.state === 'error' ? { idle: true } : {}),
  };
}

async function readCompose(
  root: string,
  service: string,
  cursor: string | undefined,
  deps: LogsDeps,
): Promise<LogsChunk> {
  const compose = await composeServices(root, deps.exec);
  if (compose.docker !== 'ok' || !compose.dir) {
    throw new LogsError('docker', 'Docker не отвечает', compose.docker);
  }
  const all = service === '*';
  const row = compose.rows.find((item) => item.service === service);
  if (!all && !row) throw new LogsError('unknown-source', `Сервиса «${service}» нет`);
  const limit = cursor ? COMPOSE_CATCH_UP : COMPOSE_TAIL;
  const args = [
    'compose',
    'logs',
    '--timestamps',
    '--no-color',
    '--tail',
    String(limit),
    ...(cursor ? ['--since', cursor] : []),
    ...(all ? [] : ['--no-log-prefix', service]),
  ];
  const result = await deps.exec(args, compose.dir, 15_000);
  if (result.code !== 0) {
    throw new LogsError(
      'docker',
      'docker compose logs не ответил',
      shortDetail(result.stderr || result.stdout),
    );
  }
  const parsed = parseComposeLogs(result.stdout, {
    withPrefix: all,
    services: compose.rows.map((item) => item.service),
  });
  const fresh = afterCursor(parsed, cursor);
  const lastStamp = [...parsed].reverse().find((line) => line.stamp)?.stamp ?? cursor;
  return {
    lines: fresh.map(({ stamp: _stamp, ...line }) => line),
    ...(lastStamp ? { cursor: lastStamp } : {}),
    ...(parsed.length >= limit ? { truncated: true } : {}),
    ...(!all && row?.state !== 'running' ? { idle: true } : {}),
  };
}

/** Новые строки источника после курсора; без курсора — хвост. */
export async function readLogs(
  root: string,
  sourceId: string,
  cursor: string | undefined,
  deps: LogsDeps,
): Promise<LogsChunk> {
  if (sourceId.startsWith('run:')) return readRun(root, sourceId.slice(4), cursor, deps);
  if (sourceId.startsWith('compose:')) return readCompose(root, sourceId.slice(8), cursor, deps);
  throw new LogsError('unknown-source', `Неизвестный источник «${sourceId}»`);
}
