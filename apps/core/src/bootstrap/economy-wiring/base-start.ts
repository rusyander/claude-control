import { join } from 'node:path';
import { runOnce } from '../../adapters/launcher/index.ts';
import { setHash, type BaseKey, type ProbeTrace } from '../../context/base/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { isInside, pathListDelimiter } from '../../platform/paths.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import type { Prepared } from '../session-road/road.types.ts';
import { probeOnStub, type ContextWiring } from './context.ts';

/**
 * Замер базы на старте сессии (G9, зона C, подключает W): тот же сеанс, что собрала дорога, —
 * вид шага, слой, строгий список MCP (`Prepared.mcpHash`), инструменты, — но адрес заглушки.
 * Идёт в фоне: запуск шага не ждёт пробы и не отказывает из-за неё. Замер есть — половина
 * ожидания первого хода (`arm`); вторую (байты первого слова) ставит экономика (`sent`).
 *
 * Пробе нужен канал адреса переходника: маршрут входа CLI (`via: login`) говорит с API вендора
 * своим входом, заглушку ему не подставить — такой сеанс не замеряется.
 *
 * Версия CLI входит в ключ кэша: новая версия меняет системную часть запроса, и замер прежней
 * судил бы её первый ход ложным дрейфом. Версия не прочиталась — сеанс не замеряется: ключ без
 * версии делили бы все версии.
 */

export const BASE_PROBE_DIR = 'base-probe';
/** `--version` отвечает за доли секунды; дольше — CLI завис, остановку ядра он не держит. */
const VERSION_TIMEOUT_MS = 10_000;

export interface BaseStartDeps {
  context: Pick<ContextWiring, 'base' | 'arm'>;
  note(event: string, data: Record<string, unknown>): void;
  /** Проба (шов теста); по умолчанию — `probeOnStub` на переходнике сеанса. */
  probe?: (p: Prepared, key: BaseKey, signal: AbortSignal) => Promise<ProbeTrace>;
  /** Версия CLI сеанса (шов теста); по умолчанию — `--version` того же CLI с пином сеанса. */
  version?: CliVersionReader;
  timeoutMs?: number;
}

/** Замер на старте сеанса; `stop` — ядро останавливается: пробы снимаются и дожидаются. */
export interface BaseStart {
  (task: LiveTask, p: Prepared): boolean;
  stop(): Promise<void>;
}

/**
 * Ключ замера: всё, что меняет системную часть первого запроса, кроме самого брифа. Слой человека
 * входит хешем описи (P87): правка CLAUDE.md, навыка или хука меняет системную часть, и прежний
 * замер не годится. Опись — с частями репозитория: доверие решится на запуске, а лишний промах
 * ключа дешевле замера, который не заметил правку.
 */
export function baseKeyOf(p: Prepared, mcpHash: string, cliVersion: string): BaseKey {
  const inventory = p.adapter.inventory?.(p.spec.env.pin, p.spec.cwd, true) ?? null;
  return {
    adapter: p.adapter.id,
    cliVersion,
    stepKind: p.start.stepKind,
    layerHash: setHash({
      layer: p.spec.layer,
      trust: p.spec.trust ?? null,
      tools: p.spec.tools,
      inventory: inventory?.hash ?? null,
    }),
    mcpHash,
  };
}

/** Версия из вывода `--version`: первое число вида x.y.z (у Claude — `2.0.14 (Claude Code)`). */
export function versionFromOutput(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(stdout)?.[1] ?? null;
}

/**
 * Окружение `--version`: пин и PATH САМОГО сеанса (`spec.env.session.PATH` — префикс задачи и
 * PATH входа поверх пина), иначе версию отвечал бы другой CLI, найденный по PATH пина (живой
 * `claude` вместо поставленного задачей). Каталог обёрток сеанса (внутри `spec.dir`) выпадает:
 * он свой у каждого сеанса — с ним запоминание на «команда × PATH» не срабатывало бы никогда.
 */
function versionEnv(p: Pick<Prepared, 'spec'>): Record<string, string> {
  const pin = p.spec.env.pin;
  const raw = p.spec.env.session?.PATH ?? pin.PATH ?? pin.Path ?? '';
  const delimiter = pathListDelimiter();
  const env: Record<string, string> = { ...pin };
  delete env.Path;
  env.PATH = raw
    .split(delimiter)
    .filter((entry) => entry !== '' && !isInside(p.spec.dir, entry))
    .join(delimiter);
  return env;
}

/** Версия CLI сеанса по его подготовке; `null` — не прочиталась. */
export type CliVersionReader = (p: Pick<Prepared, 'adapter' | 'spec'>) => Promise<string | null>;

/**
 * `--version` того же CLI тем же пином, что у сеанса: на одной машине разные PATH пина дают
 * разные установки, поэтому версия запоминается на пару «команда × PATH» — один запуск на ядро.
 * Один читатель на загрузку делят дорога (`session.started.cliVersion`) и замер базы (ключ кэша):
 * второй вызов берёт запомненное, CLI не спрашивается дважды.
 */
export function createCliVersionReader(): CliVersionReader {
  const known = new Map<string, Promise<string | null>>();
  return (p) => {
    const command = p.adapter.versionCommand;
    if (!command) return Promise.resolve(null);
    const env = versionEnv(p);
    const id = `${command}|${env.PATH}`;
    let got = known.get(id);
    if (!got) {
      got = runOnce(command, ['--version'], env, p.spec.cwd, VERSION_TIMEOUT_MS).then((r) =>
        r.ok ? versionFromOutput(r.stdout) : null,
      );
      // Неудача не запоминается: следующий сеанс спросит снова.
      void got.then((v) => {
        if (v === null) known.delete(id);
      });
      known.set(id, got);
    }
    return got;
  };
}

function stubProbe(
  p: Prepared,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<ProbeTrace> {
  const bound = p.spec.endpoint;
  if (!bound) return Promise.reject(new Error('session has no adapter endpoint channel'));
  // Свой id и каталог: проба не делит с сеансом ни разговор CLI, ни его оверлей.
  const dir = join(p.spec.dir, BASE_PROBE_DIR);
  ensureDir(dir);
  return probeOnStub(
    p.adapter,
    { ...p.spec, sessionId: newId(), dir },
    { channel: bound.channel, dialect: bound.endpoint.dialect },
    timeoutMs,
    signal,
  );
}

/** Запустить замер базы для только что запущенного сеанса; `false` — сеанс не замеряется. */
export function baseAtStart(deps: BaseStartDeps): BaseStart {
  const abort = new AbortController();
  const running = new Set<Promise<void>>();
  const versionOf = deps.version ?? createCliVersionReader();
  const probe =
    deps.probe ??
    ((pp: Prepared, _key: BaseKey, s: AbortSignal) => stubProbe(pp, deps.timeoutMs, s));

  async function measureOne(task: LiveTask, p: Prepared, mcpHash: string): Promise<void> {
    const sessionId = p.start.sessionId;
    const unmeasured = (reason: string): void =>
      deps.note('context.base.unmeasured', { taskId: task.taskId, sessionId, reason });
    try {
      const version = await versionOf(p);
      if (version === null) return unmeasured('cli version unread');
      if (abort.signal.aborted) return unmeasured('core stopping');
      const key = baseKeyOf(p, mcpHash, version);
      const got = await deps.context.base(task, key, () => probe(p, key, abort.signal));
      if (got.ok) deps.context.arm(sessionId, key, got.base.tokens);
      else unmeasured(got.reason);
    } catch (error) {
      unmeasured(error instanceof Error ? error.message : String(error));
    }
  }

  const measure = (task: LiveTask, p: Prepared): boolean => {
    if (abort.signal.aborted || !p.spec.endpoint || !p.mcpHash) return false;
    const one = measureOne(task, p, p.mcpHash);
    running.add(one);
    void one.finally(() => running.delete(one));
    return true;
  };

  return Object.assign(measure, {
    async stop(): Promise<void> {
      // Проба после остановки писала бы кэш и журнал задачи, которые ядро уже закрыло.
      abort.abort();
      await Promise.allSettled([...running]);
    },
  });
}
