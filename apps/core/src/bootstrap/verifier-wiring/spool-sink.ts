import { createHash } from 'node:crypto';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRequest, SpoolRecord } from '@agentdeck/contracts/core/records';
import type { WorkTreeOf } from '../../platform/git.ts';
import { parseFailing, passingOf } from '../../verifier/run/failing.ts';
import { verdictOf } from '../../verifier/run/verdict.ts';
import type { SpoolSink } from '../../verifier/spool/ingest.ts';
import type { RecordDraft } from '../../verifier/store/index.ts';
import { matchCaptured } from './node-script.ts';
import type { QueueWiring } from './queue.ts';

/**
 * Очередь `spool/` → хранилище записей (04:36): прогон, который прокладка исполнила без ядра,
 * ложится записью происхождения `unattended` — только обратная связь: судья её не повторяет, состав
 * её не берёт (G13, 04:13). Запись — в хранилище репозитория папки прогона, под записью реестра,
 * узнанной тем же сопоставлением, что у входа (не узнана — производный id `captured:`, 04:51).
 *
 * Ключ считается по дереву в миг забора, поэтому запись ложится только когда это то же дерево, что
 * прокладка сняла при записи в очередь (B2-F01): иначе красный прогон X лёг бы записью на
 * исправленное Y. Окружение — так же: значения в очередь не пишутся, поэтому хеш прокладки
 * сверяется с пином ядра по тем же именам; сошёлся — ключ берёт эти значения как окружение
 * вызывающего, не сошёлся — у прогона нет ключа.
 *
 * Временное (ядро без дома или ключа, реестр, дерево или пин не прочитаны, хранилище не приняло) —
 * отказ, файл ждёт следующего забора. Постоянное (папка не в репозитории, прогон в чужой папке,
 * дерево сдвинулось, окружение не пин) — неприём: файл уходит в `spool/bad/` с причиной, а не
 * спрашивается вечно. Файл, забранный, но не снятый, при повторном заборе находит свою запись.
 */

export interface SpoolSinkDeps {
  queue: Pick<QueueWiring, 'parts'>;
  workTree(dir: string): Promise<Fact<WorkTreeOf>>;
  /** id дерева рабочей копии (`scratchIndexTree`) — тот, что прокладка пишет в очередь. */
  treeId(top: string): Promise<Fact<string>>;
  /** Скрипты `package.json` папки прогона (перевод argv уровня node, A2-F01); тесты подменяют. */
  scripts?: (dir: string) => Fact<Record<string, string>>;
}

const ROAD: Record<SpoolRecord['road'], CheckRequest['road']> = {
  'node-preload': 'capture-preload',
  'path-wrapper': 'capture-wrapper',
};

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

/** Значение имени в пине: точное имя, иначе без регистра (Windows: `Tz` и `TZ` — одна переменная). */
function pinValue(pin: Readonly<Record<string, string>>, name: string): string | null {
  if (name in pin) return pin[name] ?? null;
  const upper = name.toUpperCase();
  const own = Object.keys(pin).find((k) => k.toUpperCase() === upper);
  return own === undefined ? null : (pin[own] ?? null);
}

/** Хеш окружения формой прокладки (`envDigest` в `capture-preload.cjs`): строки `[имя, значение|null]`. */
export function shimEnvDigest(rows: readonly (readonly [string, string | null])[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function storeSpoolSink(deps: SpoolSinkDeps): SpoolSink {
  return {
    async take(spooled) {
      const parts = await deps.queue.parts();
      if (!('value' in parts)) return { refused: `verifier not ready: ${why(parts)}` };
      const checks = parts.value.deps;
      const tree = await deps.workTree(spooled.cwd);
      if ('unknown' in tree) return { refused: `work tree of ${spooled.cwd}: ${tree.unknown}` };
      if ('absent' in tree) return { rejected: `${spooled.cwd} is not in a git work tree` };
      if (spooled.tree === null)
        return { rejected: 'tree of the run unread at spool time: the run proves no key' };
      const asked: CheckRequest = {
        road: ROAD[spooled.road],
        origin: 'unattended',
        // Задачи у прогона без ядра нет (прокладка не достучалась до выдачи номеров).
        taskId: '',
        stepId: null,
        project: tree.value.common, // repoKey (00 §repoKey) — как у задач ядра над этим репозиторием

        copyDir: tree.value.top,
        class: 'background',
        phase: 'mid-task',
        argv: spooled.argv,
        unit: '',
        changedUnits: [],
        exec: 'caller',
      };
      const registry = await checks.registry(asked);
      if (!('value' in registry)) return { refused: `registry: ${why(registry)}` };
      const { req: named, match } = matchCaptured(
        asked,
        registry.value,
        { cwd: spooled.cwd, prefix: tree.value.prefix },
        deps.scripts,
      );
      if (match.kind === 'absent') return { rejected: `no registry entry for ${match.checkId}` };
      const want = match.kind === 'entry' ? match.entry.cwd : '';
      if (tree.value.prefix !== want)
        return {
          rejected: `ran in ${tree.value.prefix || '.'}, while ${match.entry.id} runs in ${want || '.'}`,
        };
      const now = await deps.treeId(tree.value.top);
      if (!('value' in now)) return { refused: `tree of ${tree.value.top}: ${why(now)}` };
      if (now.value !== spooled.tree)
        return {
          rejected: `tree of ${tree.value.top} moved since the run (spooled ${spooled.tree.slice(0, 12)}, now ${now.value.slice(0, 12)}): the run proves no key of the current content`,
        };
      const pin = await checks.env(named);
      if (!('value' in pin)) return { refused: `core env pin: ${why(pin)}` };
      const rows = spooled.envNames.map((name) => [name, pinValue(pin.value, name)] as const);
      if (shimEnvDigest(rows) !== spooled.envDigest)
        return {
          rejected: `env ${spooled.envNames.join(',')} of the run differs from the core pin: values are never spooled, so the run has no key`,
        };
      const req: CheckRequest = { ...named, callerEnv: Object.fromEntries(rows) };
      const key = await checks.key({
        req,
        entry: match.entry,
        registry: registry.value,
        unit: match.unit,
        selection: [],
      });
      if (!('value' in key)) return { refused: `key: ${why(key)}` };
      const store = checks.store(req);
      if (!('value' in store)) return { refused: `store: ${why(store)}` };
      const verdict = verdictOf({
        end: 'exit',
        exit: spooled.exit,
        signal: null,
        ms: spooled.ms,
        log: spooled.log,
        logBytes: Buffer.byteLength(spooled.log),
        truncated: spooled.truncated,
        failing: [],
        standEpoch: null,
        standMoved: false,
        temp: { removed: true },
      });
      const draft: RecordDraft = {
        key: key.value.key,
        parts: key.value.parts,
        checkId: match.entry.id,
        unit: match.unit,
        grade: 'unit',
        origin: 'unattended',
        verdict,
        exit: spooled.exit,
        ms: spooled.ms,
        startedAt: Math.max(0, spooled.at - spooled.ms),
        argv: spooled.argv,
        failing:
          spooled.exit !== null && spooled.exit !== 0
            ? parseFailing(match.entry.filter?.kind, spooled.log)
            : [],
        ...passingOf('exit', match.entry.filter?.kind, spooled.log),
        retries: [],
        artifacts: null,
        envPrepared: false,
        standEpoch: null,
        taskId: null,
        checkRunId: null,
      };
      // Файл, забранный прошлым проходом, но не снятый (A2-F07), — тот же прогон, не второй:
      // запись `unattended` с тем же мигом, длительностью, кодом и argv уже лежит под ключом.
      const scanned = store.value.scan(key.value.key);
      const same =
        'value' in scanned
          ? scanned.value.records.find(
              (r) =>
                r.origin === 'unattended' &&
                r.startedAt === draft.startedAt &&
                r.ms === draft.ms &&
                r.exit === draft.exit &&
                r.argv.length === draft.argv.length &&
                r.argv.every((a, i) => a === draft.argv[i]),
            )
          : undefined;
      if (same) return { taken: same.id };
      // Лог, обрезанный прокладкой (голова + хвост), запись не назовёт целым (B2-F02).
      const written = store.value.write(draft, spooled.log, spooled.truncated);
      return 'value' in written
        ? { taken: written.value }
        : { refused: `store refused: ${why(written)}` };
    },
  };
}
