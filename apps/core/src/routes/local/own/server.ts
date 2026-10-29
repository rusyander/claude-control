import { join } from 'node:path';
import type { AbortLike } from '@agentdeck/contracts/core/routes';
import { helperEnv } from '../../../platform/detached-launch.ts';
import {
  describeKeptExit,
  launchKept,
  pidAlive,
  readKeptExit,
} from '../../../platform/kept-launch.ts';
import { allocatePort, LOOPBACK } from '../../../platform/ports.ts';
import type { ProcessIdentity } from '../../../platform/process-table.ts';
import { writeFileAtomic } from '../../../platform/safe-io/atomic-write.ts';
import { ensureDir } from '../../../platform/safe-io/files.ts';
import { stopTree, type TreeStopReport } from '../../../platform/tree-stop.ts';
import { RouteAborted } from '../../lease.ts';
import { createRouterClient, type RouterClient } from './client.ts';

/**
 * Свой llama-server в режиме маршрутизатора (11 R:PR-04): модели — файлом пресета, загрузка —
 * только по запросу ядра (`--no-models-autoload`), не больше одной разом (`--models-max 1`),
 * слушает только loopback на выделенном порте (никогда 5170–5180). Раннеры моделей —
 * дочерние процессы маршрутизатора: остановка — ДЕРЕВОМ, иначе сирота-раннер держит память
 * карты (случай владельца 12.09). Метка окружения дерева находит переродившихся (Linux, macOS).
 */

export const TREE_MARKER_NAME = 'AGENTDECK_TREE';

/** Старт хранителя, чью личность не прочитали: строки таблицы с ним не совпадёт ни одна. */
const UNREAD_START = 'unread:';

export interface PresetModel {
  id: string;
  path: string;
}

export interface RouterServerSpec {
  /** Имя или путь бинаря сервера; ищется по PATH окружения запуска. */
  command: string;
  /** Аргументы перед своими (например, скрипт подставного сервера в тестах). */
  leadArgs?: readonly string[];
  extraArgs?: readonly string[];
  /** Каталог аренды: файл пресета и cwd сервера. */
  workDir: string;
  models: readonly PresetModel[];
  /** Метка дерева — rid ресурса сервера. */
  marker: string;
  env?: Record<string, string>;
  startTimeoutMs?: number;
  attempts?: number;
  /** Задача снята: ожидание готовности прерывается, поднявшееся снимается деревом (F-65). */
  signal?: AbortLike;
  /**
   * Запуск не удался, а снятие того, что успело родиться, не доказано (остаток или таблица не
   * прочитана): текст — освобождению, которое не отдаст слот за живым деревом (F-64).
   */
  onLeftover?: (text: string, root: ProcessIdentity | number) => void;
}

export interface RunningRouter {
  origin: string;
  port: number;
  identity: ProcessIdentity;
  marker: string;
  client: RouterClient;
}

/**
 * INI пресета: секция — id модели, `model` — путь файла. Перевод строки — `\n` (его читает llama).
 * Знаки комментария INI (`;`, `#`) отказываются: разбор, срезающий хвостовой комментарий, молча
 * отрезал бы путь и загрузил бы не тот файл (F-117).
 */
export function presetIni(models: readonly PresetModel[]): string {
  return models
    .map((model) => {
      if (/[\]\r\n]/.test(model.id) || /[\r\n]/.test(model.path))
        throw new Error(`preset entry ${JSON.stringify(model.id)} has a line break or bracket`);
      if (/[;#]/.test(model.id) || /[;#]/.test(model.path))
        throw new Error(
          `preset entry ${JSON.stringify(model.id)} has an INI comment character (; or #) in its id or path`,
        );
      return `[${model.id}]\nmodel = ${model.path}\n`;
    })
    .join('\n');
}

export function routerArgs(presetPath: string, port: number): string[] {
  return [
    '--models-preset',
    presetPath,
    '--models-max',
    '1',
    '--no-models-autoload',
    '--host',
    LOOPBACK,
    '--port',
    String(port),
    '--no-webui',
  ];
}

const ABORTED = 'aborted: task cancelled while the server was starting';

async function waitHealthy(
  client: RouterClient,
  exited: () => string | undefined,
  timeoutMs: number,
  signal: AbortLike | undefined,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return ABORTED;
    const gone = exited();
    if (gone) return gone;
    if (await client.healthy()) return undefined;
    await new Promise((done) => setTimeout(done, 200));
  }
  return `not healthy in ${timeoutMs} ms`;
}

/** Остаток снятия, если он есть: без него — пусто. */
function leftoverOf(report: TreeStopReport): string | undefined {
  if (report.residual.length === 0 && !report.unknown) return undefined;
  return `tree residual: ${report.residual.map((p) => p.pid).join(', ') || '-'}${report.unknown ? `; ${report.unknown}` : ''}`;
}

/**
 * Снять поднявшееся при неудачном запуске. Личность хранителя известна — деревом; не прочитана
 * (F-64) — только по метке окружения: её несут и хранитель, и сервер, а сигнал группе по номеру
 * без доказанной личности мог бы задеть чужую группу.
 */
export async function stopStarted(
  root: ProcessIdentity | number,
  marker: string,
): Promise<TreeStopReport> {
  const known = typeof root !== 'number';
  return stopTree(known ? root : { pid: root, start: `${UNREAD_START}${root}` }, {
    group: known,
    marker: { name: TREE_MARKER_NAME, value: marker },
  });
}

/**
 * Снять остаток неудачного запуска и сказать, что осталось (пусто — снят доказанно). Поиск по
 * метке мог не увидеть хранителя (окружение не прочиталось): живой номер без личности — не снят.
 * Хранитель, взятый поиском по метке, уже снят ПО ЛИЧНОСТИ (номер + старт из того же снимка), и
 * чистый отчёт доказал его уход: номер, ответивший после, — чужой процесс. Windows отдаёт номер
 * снятого новому за миллисекунды (полный прогон 29.10: «keeper pid … alive after the stop» —
 * слот держался за чужим процессом вечно, до точки человека).
 */
export async function stopLeftover(
  root: ProcessIdentity | number,
  marker: string,
): Promise<string | undefined> {
  const report = await stopStarted(root, marker);
  const left = leftoverOf(report);
  if (left || typeof root !== 'number') return left;
  if (report.targeted.some((id) => id.pid === root)) return undefined;
  if (pidAlive(root)) return `keeper pid ${root} alive after the stop, identity unread`;
  return undefined;
}

export async function startRouter(spec: RouterServerSpec): Promise<RunningRouter> {
  const presetPath = join(spec.workDir, 'models-preset.ini');
  writeFileAtomic(presetPath, presetIni(spec.models));
  const env = { ...helperEnv(), ...spec.env, [TREE_MARKER_NAME]: spec.marker };
  const failures: string[] = [];
  // Неудачный запуск снят не доказанно — дальше не пробовать: второй сервер рядом с остатком.
  const stopped = async (root: ProcessIdentity | number): Promise<boolean> => {
    const left = await stopLeftover(root, spec.marker);
    if (!left) return true;
    failures.push(`stop after the failed start: ${left}`);
    spec.onLeftover?.(left, root);
    return false;
  };
  for (let attempt = 0; attempt < (spec.attempts ?? 3); attempt += 1) {
    if (spec.signal?.aborted) throw new RouteAborted('model server start');
    const { port } = await allocatePort();
    // Свой каталог состояния на попытку: файл выхода прошлой попытки не выдаётся за этот.
    const stateDir = join(spec.workDir, `keeper-${attempt}`);
    ensureDir(stateDir);
    // Через хранителя: сервер переживает ядро, перезапущенное ядро возвращается к нему.
    const started = await launchKept({
      command: spec.command,
      args: [...(spec.leadArgs ?? []), ...routerArgs(presetPath, port), ...(spec.extraArgs ?? [])],
      cwd: spec.workDir,
      env,
      stateDir,
      marker: { name: TREE_MARKER_NAME, value: spec.marker },
    });
    if (!started.ok) {
      // Хранитель не запускался (цель не найдена, запуск отказан) — повтор ничего не даст.
      if (started.pid === undefined)
        throw new Error(`model server did not start: ${started.reason}`);
      failures.push(`port ${port}: ${started.reason}`);
      // Номер есть, личности нет: хранитель (и сервер под ним) мог остаться жив — снять по метке.
      if (!(await stopped(started.pid))) break;
      if (started.reason.startsWith('exited early')) continue;
      break;
    }
    const { identity } = started;
    // Хранитель вышел — значит, вышла цель; его файл называет код и сигнал.
    const exited = (): string | undefined =>
      pidAlive(identity.pid)
        ? undefined
        : (describeKeptExit(readKeptExit(stateDir)) ?? 'exited early (keeper gone)');
    const origin = `http://${LOOPBACK}:${port}`;
    const client = createRouterClient(origin);
    const problem = await waitHealthy(client, exited, spec.startTimeoutMs ?? 60_000, spec.signal);
    if (!problem) return { origin, port, identity, marker: spec.marker, client };
    failures.push(`port ${port}: ${problem}`);
    // Не поднялся — снять всё, что успело родиться, прежде чем пробовать другой порт.
    const clean = await stopped(identity);
    if (problem === ABORTED) throw new RouteAborted('model server start');
    // Ранний выход — чаще всего порт заняли между пробой и запуском: следующий порт.
    if (!clean || !problem.startsWith('exited early')) break;
  }
  throw new Error(`model server failed to start: ${failures.join('; ')}`);
}

/** Вернуться к уже идущему серверу (перезапущенное ядро): клиент по адресу, личность — из записи. */
export function attachRouter(running: Omit<RunningRouter, 'client'>): RunningRouter {
  return { ...running, client: createRouterClient(running.origin) };
}

export async function stopRouter(router: RunningRouter): Promise<TreeStopReport> {
  return stopTree(router.identity, {
    group: true,
    marker: { name: TREE_MARKER_NAME, value: router.marker },
  });
}
