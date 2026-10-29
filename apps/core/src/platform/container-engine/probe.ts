import { existsSync } from 'node:fs';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { EngineInfo } from '@agentdeck/contracts/core/records';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import type { EngineHandle, EngineProbeOptions, EngineRun } from '../container-engine.types.ts';
import { resolveExecutable } from '../exec-resolve.ts';
import { currentOs, envValue, homeDir, userRuntimeDir, type OsKind } from '../os-kind.ts';
import { runTool } from '../run-tool.ts';

/**
 * Движок контейнеров (04:126-127, 09:30, P58). Порядок проб: `docker` по своему контексту
 * (`DOCKER_HOST` / текущий контекст), `podman`, затем `docker` по известным сокетам ОС (Podman,
 * Colima, OrbStack без контекста — «run through the socket»). Ответ:
 *   value   — сервер ответил, известны вид, сокет и compose;
 *   absent  — ни `docker`, ни `podman` нет в PATH: говорить нечем;
 *   unknown — CLI есть, сервер молчит (ВМ Docker Desktop остановлена, сокет мёртв) или таймаут.
 * Класс чтения `engine.info` (`onUnknown: refuse`): проверки с сервисами — `no-verdict(env)`,
 * никогда не зелёные.
 */

/** Известные сокеты движков без контекста CLI (09:30). npipe — Windows, остальное — unix. */
export function knownSockets(
  env: NodeJS.ProcessEnv = process.env,
  os: OsKind = currentOs(),
): string[] {
  if (os === 'win32') {
    return ['npipe:////./pipe/podman-machine-default', 'npipe:////./pipe/docker_engine'];
  }
  const home = homeDir(env, os);
  const runtime = userRuntimeDir(env);
  const out: string[] = [];
  if (runtime) out.push(`unix://${runtime}/podman/podman.sock`);
  if (os === 'linux') out.push('unix:///run/podman/podman.sock');
  out.push(
    `unix://${home}/.colima/default/docker.sock`,
    `unix://${home}/.orbstack/run/docker.sock`,
  );
  if (os === 'darwin') {
    out.push(
      `unix://${home}/.local/share/containers/podman/machine/podman.sock`,
      `unix://${home}/.docker/run/docker.sock`,
    );
  }
  out.push('unix:///var/run/docker.sock');
  return out;
}

interface VersionJson {
  Client?: { Context?: string; Version?: string; Os?: string } | null;
  Server?: {
    Version?: string;
    Os?: string;
    Platform?: { Name?: string };
    Components?: { Name?: string }[];
  } | null;
}

/**
 * Вид движка по ответу `version` (чистая функция; записанные ответы OrbStack / Colima / Podman
 * проверяются тестом разбора — macOS только кодом, 09 §Verification).
 */
export function engineKind(
  version: VersionJson,
  cli: 'docker' | 'podman',
  socket: string,
): EngineInfo['kind'] {
  const server = version.Server ?? {};
  const components = (server.Components ?? []).map((c) => c.Name ?? '');
  const platform = server.Platform?.Name ?? '';
  const context = version.Client?.Context ?? '';
  if (cli === 'podman' || components.some((name) => /podman/i.test(name))) return 'podman';
  if (/orbstack/i.test(platform) || /orbstack/i.test(context) || /orbstack/i.test(socket))
    return 'orbstack';
  if (/colima/i.test(context) || /colima/i.test(socket)) return 'colima';
  if (/docker/i.test(platform) || components.includes('Engine')) return 'docker';
  return 'docker-compatible';
}

interface Candidate {
  cli: 'docker' | 'podman';
  file: string;
  prefix: string[];
  /** `DOCKER_HOST` этой пробы; `undefined` — контекст CLI как есть. */
  host?: string;
}

function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

function unixPath(socket: string): string | undefined {
  return socket.startsWith('unix://') ? socket.slice('unix://'.length) : undefined;
}

async function serverVersion(
  c: Candidate,
  env: NodeJS.ProcessEnv,
  run: EngineRun,
): Promise<{ version: VersionJson } | { fail: string }> {
  const args =
    c.cli === 'podman' ? ['version', '--format', 'json'] : ['version', '--format', '{{json .}}'];
  // Ненулевой код при молчащем сервере — ответ (клиентская половина JSON есть), а не сбой запуска.
  const got = await run(c.file, [...c.prefix, ...args], {
    timeoutMs: 8_000,
    env,
    acceptNonZero: true,
  });
  const where = `${c.cli}${c.host ? ` @ ${c.host}` : ''}`;
  if (!got.ok) return { fail: `${where}: ${got.reason}` };
  let parsed: VersionJson;
  try {
    parsed = JSON.parse(got.stdout.trim() || 'null') as VersionJson;
  } catch {
    return { fail: `${where}: version output is not JSON (${firstLine(got.stdout)})` };
  }
  if (!parsed || typeof parsed !== 'object') return { fail: `${where}: empty version` };
  // У podman без машины (Linux, без демона) сервер — сам клиент.
  if (c.cli === 'podman' && !parsed.Server && got.code === 0) parsed.Server = parsed.Client ?? {};
  if (!parsed.Server || got.code !== 0) {
    return { fail: `${where}: server not answering (${firstLine(got.stderr)})` };
  }
  return { version: parsed };
}

async function contextHost(c: Candidate, env: NodeJS.ProcessEnv, run: EngineRun): Promise<string> {
  const explicit = envValue(env, 'DOCKER_HOST');
  if (explicit) return explicit;
  if (c.cli === 'podman') return 'podman';
  const got = await run(
    c.file,
    [...c.prefix, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { timeoutMs: 8_000, env },
  );
  return got.ok && got.stdout.trim() ? got.stdout.trim() : 'default';
}

async function composeOf(
  c: Candidate,
  env: NodeJS.ProcessEnv,
  os: OsKind,
  run: EngineRun,
  resolve: typeof resolveExecutable,
): Promise<{ composeV2: boolean; composeV1: boolean }> {
  const v2 = await run(c.file, [...c.prefix, 'compose', 'version'], { timeoutMs: 8_000, env });
  const v1bin = resolve('docker-compose', { env, os });
  const v1 = v1bin.ok
    ? await run(v1bin.file, [...v1bin.prefix, 'version'], { timeoutMs: 8_000, env })
    : undefined;
  return { composeV2: v2.ok, composeV1: v1?.ok === true };
}

/** Проба целиком; бросает `engine-down: …`, когда CLI есть, а ни один сервер не ответил. */
async function probeEngine(options: EngineProbeOptions): Promise<EngineHandle | { absent: true }> {
  const env = options.env ?? process.env;
  const os = options.os ?? currentOs();
  const run = options.run ?? runTool;
  const resolve = options.resolve ?? resolveExecutable;
  const socketExists = options.socketExists ?? existsSync;
  const docker = resolve('docker', { env, os });
  const podman = resolve('podman', { env, os });
  if (!docker.ok && !podman.ok) {
    // Найденный, но отвергнутый CLI (обёртка .cmd без оболочки) — не «Docker не установлен»:
    // говорить с ним нечем, ответ `unknown` с причиной, как у `handleOf`.
    const refused = [docker, podman].flatMap((r) => (r.absent ? [] : [`${r.found}: ${r.refused}`]));
    if (refused.length > 0) throw new Error(`engine-cli-refused: ${refused.join('; ')}`);
    return absent();
  }
  const tries: Candidate[] = [];
  if (docker.ok) tries.push({ cli: 'docker', file: docker.file, prefix: docker.prefix });
  if (podman.ok) tries.push({ cli: 'podman', file: podman.file, prefix: podman.prefix });
  if (docker.ok) {
    for (const socket of options.sockets ?? knownSockets(env, os)) {
      const path = unixPath(socket);
      if (path !== undefined && !socketExists(path)) continue;
      tries.push({ cli: 'docker', file: docker.file, prefix: docker.prefix, host: socket });
    }
  }
  const failures: string[] = [];
  for (const c of tries) {
    const callEnv: NodeJS.ProcessEnv = c.host ? { ...env, DOCKER_HOST: c.host } : { ...env };
    const answer = await serverVersion(c, callEnv, run);
    if ('fail' in answer) {
      failures.push(answer.fail);
      continue;
    }
    const socket = c.host ?? (await contextHost(c, callEnv, run));
    const compose = await composeOf(c, callEnv, os, run, resolve);
    const server = answer.version.Server ?? {};
    return {
      info: {
        kind: engineKind(answer.version, c.cli, socket),
        socket,
        ...compose,
        cli: c.cli,
        viaSocket: c.host !== undefined,
        serverVersion: server.Version ?? '',
        serverOs: server.Os ?? '',
      },
      file: c.file,
      prefix: c.prefix,
      env: callEnv,
    };
  }
  throw new Error(`engine-down: ${failures.join('; ')}`);
}

/** Движок с тем, чем с ним говорить. Класс чтения `engine.info` (таймаут, unknown — отказ). */
export function engineHandle(options: EngineProbeOptions = {}): Promise<Fact<EngineHandle>> {
  return readFact<EngineHandle>(
    'engine.info',
    () => probeEngine(options),
    options.setTimer ? { setTimer: options.setTimer } : {},
  );
}

/** `engineFact()` — общий интерфейс плана (§2): предполётная проба E, обёртки D, сервисы F. */
export async function engineFact(options: EngineProbeOptions = {}): Promise<Fact<EngineInfo>> {
  const got = await engineHandle(options);
  return 'value' in got ? { value: got.value.info } : got;
}

/**
 * Обращение к уже найденному движку по записи ресурса (после краха ядра): тот же CLI, тот же
 * сокет. CLI исчез из PATH — `absent`: говорить нечем, снятие назовёт утечку.
 */
export function handleOf(
  info: EngineInfo,
  options: Pick<EngineProbeOptions, 'env' | 'os' | 'resolve'> = {},
): Fact<EngineHandle> {
  const env = options.env ?? process.env;
  const resolve = options.resolve ?? resolveExecutable;
  const cli = resolve(info.cli, { env, ...(options.os ? { os: options.os } : {}) });
  if (!cli.ok) return cli.absent ? absent() : { unknown: `${info.cli}: ${cli.refused}` };
  // Сокет записан адресом — он и закрепляется: контекст CLI мог смениться между стартом и снятием.
  const pinned = info.socket.includes('://');
  return {
    value: {
      info,
      file: cli.file,
      prefix: cli.prefix,
      env: pinned && info.cli === 'docker' ? { ...env, DOCKER_HOST: info.socket } : { ...env },
    },
  };
}
