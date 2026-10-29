import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  ContainerRow,
  ContainerSpec,
  EngineHandle,
  EngineRelease,
} from '../container-engine.types.ts';
import { reasonOf } from '../os-kind.ts';
import { TASK_LABEL } from '../resource-scan.ts';
import { runTool, type ToolOptions, type ToolRun } from '../run-tool.ts';

/**
 * Действия над движком (04:124-127): запуск сервиса, порты, метки, исполнение внутри, снятие с
 * чтением назад. Снимается только контейнер с меткой `claude.ephemeral=1` и метками задачи —
 * чужой контейнер ядро не трогает никогда (P40, правило машины: «docker rm только по метке»).
 * Тома — только кэши (`agentdeck.cache`), их ядро оставляет и называет; снятие — по команде.
 */

export const EPHEMERAL_LABEL = 'claude.ephemeral';
export const CACHE_LABEL = 'agentdeck.cache';

/**
 * Ответ демона «такого нет» (docker и podman пишут «no such …»). Голое «not found» сюда не входит:
 * `context "colima": context not found` — сбой CLI до демона, и `absent` дал бы снятию ложное
 * «проверено, нет», а контейнер жил бы дальше.
 */
const NO_SUCH = /no such (object|container|volume|pod)/i;

function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

export function runEngine(
  h: EngineHandle,
  args: readonly string[],
  options: ToolOptions = {},
): Promise<ToolRun> {
  return (h.run ?? runTool)(h.file, [...h.prefix, ...args], {
    timeoutMs: 30_000,
    ...options,
    env: h.env,
  });
}

function failure(what: string, run: Extract<ToolRun, { ok: false }>): string {
  return `${what}: ${firstLine(run.stderr) || run.reason}`;
}

/** Метки контейнера, тома или пода podman; нет такого — `absent`. */
async function labelsOf(
  h: EngineHandle,
  kind: 'container' | 'volume' | 'pod',
  ref: string,
): Promise<Fact<Record<string, string>>> {
  const format = kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}';
  const got = await runEngine(h, [kind, 'inspect', '--format', format, ref], {
    timeoutMs: 20_000,
  });
  if (!got.ok) {
    if (NO_SUCH.test(got.stderr ?? '')) return { absent: true };
    return { unknown: failure(`${kind} inspect`, got) };
  }
  try {
    const parsed = JSON.parse(got.stdout.trim() || 'null') as Record<string, string> | null;
    return { value: parsed ?? {} };
  } catch (error) {
    return { unknown: `${kind} inspect labels: ${reasonOf(error)}` };
  }
}

export function containerLabels(
  h: EngineHandle,
  id: string,
): Promise<Fact<Record<string, string>>> {
  return labelsOf(h, 'container', id);
}

/** Запуск сервиса: метка эфемерности ставится всегда, порты — только на 127.0.0.1. */
export async function runContainer(h: EngineHandle, spec: ContainerSpec): Promise<Fact<string>> {
  const labels = { ...spec.labels, [EPHEMERAL_LABEL]: '1' };
  const args = ['run', '-d'];
  for (const [key, value] of Object.entries(labels).sort()) args.push('--label', `${key}=${value}`);
  for (const [key, value] of Object.entries(spec.env).sort()) args.push('-e', `${key}=${value}`);
  for (const port of spec.ports) args.push('-p', `127.0.0.1::${port}`);
  args.push(spec.image, ...(spec.command ?? []));
  // Образа может не быть локально — первый запуск тянет его; срок под это.
  const got = await runEngine(h, args, { timeoutMs: 600_000 });
  if (!got.ok) return { unknown: failure('run', got) };
  const id = got.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (!/^[0-9a-f]{12,64}$/.test(id)) return { unknown: `run: no container id in output (${id})` };
  return { value: id };
}

/** Опубликованные порты: порт контейнера → порт хоста на 127.0.0.1. */
export async function publishedPorts(
  h: EngineHandle,
  id: string,
): Promise<Fact<Record<number, number>>> {
  const got = await runEngine(h, ['inspect', '--format', '{{json .NetworkSettings.Ports}}', id], {
    timeoutMs: 20_000,
  });
  if (!got.ok) {
    if (NO_SUCH.test(got.stderr ?? '')) return { absent: true };
    return { unknown: failure('inspect ports', got) };
  }
  try {
    const raw = JSON.parse(got.stdout.trim() || 'null') as Record<
      string,
      { HostIp?: string; HostPort?: string }[] | null
    > | null;
    const out: Record<number, number> = {};
    for (const [key, binds] of Object.entries(raw ?? {})) {
      const port = Number(key.split('/')[0]);
      const host = (binds ?? []).find((b) => b.HostPort && /^\d+$/.test(b.HostPort));
      if (Number.isInteger(port) && host?.HostPort) out[port] = Number(host.HostPort);
    }
    return { value: out };
  } catch (error) {
    return { unknown: `inspect ports: ${reasonOf(error)}` };
  }
}

/** Контейнеры со ВСЕМИ метками (`--filter label=…` движок складывает через И). */
export async function listByLabels(
  h: EngineHandle,
  labels: Record<string, string>,
): Promise<Fact<ContainerRow[]>> {
  const args = ['ps', '-a', '--no-trunc'];
  for (const [key, value] of Object.entries(labels).sort())
    args.push('--filter', `label=${key}=${value}`);
  args.push('--format', '{{.ID}}\t{{.Names}}\t{{.State}}');
  const got = await runEngine(h, args, { timeoutMs: 20_000 });
  if (!got.ok) return { unknown: failure('ps', got) };
  const rows = got.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', state = ''] = line.split('\t');
      return { id, name, state };
    });
  return { value: rows };
}

/** Есть ли контейнер с этим id (чтение назад снятия и сверка `container-remove`). */
export async function containerPresent(h: EngineHandle, id: string): Promise<Fact<boolean>> {
  const got = await runEngine(h, ['ps', '-a', '-q', '--no-trunc', '--filter', `id=${id}`], {
    timeoutMs: 20_000,
  });
  if (!got.ok) return { unknown: failure('ps', got) };
  return { value: got.stdout.trim() !== '' };
}

function labelsMatch(have: Record<string, string>, need: Record<string, string>): string | null {
  if (have[EPHEMERAL_LABEL] !== '1') return `no ${EPHEMERAL_LABEL}=1 label`;
  for (const [key, value] of Object.entries(need)) {
    if (have[key] !== value) return `label ${key} is ${have[key] ?? 'absent'}, expected ${value}`;
  }
  return null;
}

/**
 * Снятие контейнера ядра: метки сверяются ДО `rm` (не наш — `refused`, не тронут), `rm -f -v`
 * (анонимные тома образа уходят с ним — иначе остался бы ресурс, P40), чтение назад по id.
 */
export async function removeEphemeral(
  h: EngineHandle,
  id: string,
  mustLabels: Record<string, string>,
): Promise<EngineRelease> {
  const labels = await containerLabels(h, id);
  if ('absent' in labels) return { verified: `container ${id} absent` };
  if ('unknown' in labels) return { leak: `labels read: ${labels.unknown}` };
  const mismatch = labelsMatch(labels.value, mustLabels);
  if (mismatch) return { refused: `container ${id} not ours: ${mismatch}` };
  return rmReadBack(h, id);
}

/** `rm -f -v` и чтение назад по id: «снято» — только когда `ps` его больше не видит. */
async function rmReadBack(h: EngineHandle, id: string): Promise<EngineRelease> {
  const removed = await runEngine(h, ['rm', '-f', '-v', id], { timeoutMs: 120_000 });
  const after = await containerPresent(h, id);
  if ('unknown' in after) return { leak: `read-back: ${after.unknown}` };
  if ('value' in after && after.value) {
    return { leak: `container still present${removed.ok ? '' : `: ${failure('rm', removed)}`}` };
  }
  return { verified: `container ${id} absent` };
}

/**
 * Команда внутри контейнера; `input` идёт на stdin (SQL миграции без временных файлов). Через
 * `runEngine`, как всякий вызов движка (ревью A2r5-F09): тест решений подменяет его `h.run`.
 * Ненулевой код — ответ команды, не сбой; срок рвёт CLI движка, процесс внутри контейнера живёт
 * до снятия контейнера (контейнер сервиса — ресурс задачи, его снимает конец задачи).
 */
export async function execIn(
  h: EngineHandle,
  id: string,
  argv: readonly string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string } | { error: string }> {
  const { input } = options;
  const got = await runEngine(h, ['exec', ...(input !== undefined ? ['-i'] : []), id, ...argv], {
    timeoutMs: options.timeoutMs ?? 120_000,
    acceptNonZero: true,
    ...(input !== undefined ? { input } : {}),
  });
  if (!got.ok) return { error: got.reason };
  return { code: got.code, stdout: got.stdout, stderr: got.stderr };
}

/** Именованный том — только кэш (04:100-101, 04:126): живёт дольше задачи, назван в отчёте. */
export async function ensureCacheVolume(
  h: EngineHandle,
  name: string,
): Promise<Fact<'created' | 'existed'>> {
  const have = await labelsOf(h, 'volume', name);
  if ('value' in have) {
    return have.value[CACHE_LABEL] === '1'
      ? { value: 'existed' }
      : { unknown: `volume ${name} exists without ${CACHE_LABEL}=1 — not ours to mount as cache` };
  }
  if ('unknown' in have) return have;
  const got = await runEngine(h, ['volume', 'create', '--label', `${CACHE_LABEL}=1`, name], {
    timeoutMs: 30_000,
  });
  if (!got.ok) return { unknown: failure('volume create', got) };
  return { value: 'created' };
}

/**
 * Метка задачи на находке сессии ДО `rm -f` (ревью B2r2-F01): находку могли приписать задаче по
 * окну вызова (`kube play`, проект compose), а контейнер в нём создала параллельная задача. Метка
 * другой задачи — отказ, не тронут; нет метки или метка этой задачи — снимать; метки не прочитать
 * — утечка, а не `rm` вслепую (P44). `null` — можно снимать.
 */
async function sessionGate(
  h: EngineHandle,
  kind: 'container' | 'pod',
  id: string,
  taskId: string,
): Promise<EngineRelease | null> {
  const labels = await labelsOf(h, kind, id);
  if ('absent' in labels) return { verified: `${kind} ${id} absent` };
  if ('unknown' in labels) return { leak: `${kind} ${id} labels unread: ${labels.unknown}` };
  const owner = labels.value[TASK_LABEL];
  if (owner !== undefined && owner !== '' && owner !== taskId) {
    return { refused: `${kind} ${id} labelled for task ${owner} — not removed` };
  }
  return null;
}

/**
 * Контейнер, найденный сессией (01 §Resources): метка задачи сверяется до `rm -f -v` (анонимные
 * тома уходят с ним, как у контейнера ядра), чтение назад по id.
 */
export async function removeSessionContainer(
  h: EngineHandle,
  id: string,
  taskId: string,
): Promise<EngineRelease> {
  return (await sessionGate(h, 'container', id, taskId)) ?? rmReadBack(h, id);
}

/**
 * Под Podman, найденный сессией (G18): создан после снимка шага — ресурс задачи; метка задачи
 * сверяется до `pod rm -f` (с его контейнерами), чтение назад по id.
 */
export async function removePod(
  h: EngineHandle,
  id: string,
  taskId: string,
): Promise<EngineRelease> {
  const gate = await sessionGate(h, 'pod', id, taskId);
  if (gate) return gate;
  const removed = await runEngine(h, ['pod', 'rm', '-f', id], { timeoutMs: 60_000 });
  const after = await runEngine(h, ['pod', 'ps', '-q', '--no-trunc', '--filter', `id=${id}`], {
    timeoutMs: 20_000,
  });
  if (!after.ok) return { leak: failure('pod ps read-back', after) };
  if (after.stdout.trim() !== '') {
    return { leak: `pod still present${removed.ok ? '' : `: ${failure('pod rm', removed)}`}` };
  }
  return { verified: `pod ${id} absent` };
}

/** Снятие тома-кэша по команде человека: только с меткой кэша, чтение назад. */
export async function removeCacheVolume(h: EngineHandle, name: string): Promise<EngineRelease> {
  const have = await labelsOf(h, 'volume', name);
  if ('absent' in have) return { verified: `volume ${name} absent` };
  if ('unknown' in have) return { leak: `volume read: ${have.unknown}` };
  if (have.value[CACHE_LABEL] !== '1') return { refused: `volume ${name} has no ${CACHE_LABEL}=1` };
  const removed = await runEngine(h, ['volume', 'rm', name], { timeoutMs: 60_000 });
  const after = await labelsOf(h, 'volume', name);
  if ('absent' in after) return { verified: `volume ${name} absent` };
  if ('unknown' in after) return { leak: `read-back: ${after.unknown}` };
  return { leak: `volume still present${removed.ok ? '' : `: ${failure('volume rm', removed)}`}` };
}
