import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GlobalLayerApplyRequest,
  GlobalLayerApplyResponse,
  GlobalLayerPairView,
  GlobalLayerProposal,
  GlobalLayerSide,
  GlobalLayerTransferRequest,
  GlobalLayerTransferResponse,
} from '@agentdeck/contracts';
import { readJsonFile, writeJsonFile, writeTextFile } from '../../lib/safe-io/safe-io.ts';
import { diffLines } from '../history/diff.ts';
import {
  PANEL_REPO_ROOT,
  fingerprint,
  runComparison,
  type ComparisonInput,
  type ComparisonResult,
} from './compare.ts';
import { corpusPath, loadRegistry, type PairEntry } from './registry.ts';
import { transferPrompt } from './transfer.ts';

/**
 * Сверка панели с глобальным слоем: последняя сверка каждой пары, отметка
 * «файл изменился» и перенос.
 *
 * Состояние — файл `global-layer/state.json` в данных панели: вердикт и
 * отпечатки сторон переживают перезапуск, и правка глобального файла, пока
 * панель лежала, тоже видна — отпечаток не совпадёт с записанным.
 *
 * Запись в каталог конфигурации здесь одна — `apply`: только файлы из
 * предложения, только когда оба отпечатка совпали с теми, что человек видел в
 * диффе, и всегда с резервной копией (а не по тумблеру «копия перед записью»).
 */

export interface GlobalLayerDeps {
  read: () => { configRoot: string; appData: string; backupDir: string };
  /** Разослать подписчикам: карточка перечитает пары. */
  onChange: () => void;
  repoRoot?: string;
  registry?: PairEntry[];
  compare?: (input: ComparisonInput) => Promise<ComparisonResult>;
  now?: () => Date;
}

interface PairState extends ComparisonResult {
  comparedAt: string;
  changed?: { at: string; sides: GlobalLayerSide[] };
}

export class GlobalLayerError extends Error {
  readonly code: 'unknown-pair' | 'stale-proposal' | 'not-in-pair';

  constructor(code: GlobalLayerError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

export function createGlobalLayer(deps: GlobalLayerDeps) {
  const repoRoot = deps.repoRoot ?? PANEL_REPO_ROOT;
  const registry = deps.registry ?? loadRegistry();
  const compare = deps.compare ?? runComparison;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const running = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();

  const stateFile = () => join(deps.read().appData, 'global-layer', 'state.json');
  const proposalDir = (id: string) => join(deps.read().appData, 'global-layer', id, 'proposal');
  const loadState = (): Record<string, PairState> =>
    readJsonFile<Record<string, PairState>>(stateFile(), {});
  const saveState = (state: Record<string, PairState>): void => {
    mkdirSync(join(deps.read().appData, 'global-layer'), { recursive: true });
    writeJsonFile(stateFile(), state);
  };

  const pairOf = (id: string): PairEntry => {
    const pair = registry.find((entry) => entry.id === id);
    if (!pair) throw new GlobalLayerError('unknown-pair', `unknown pair ${id}`);
    return pair;
  };

  const currentHashes = (pair: PairEntry) => ({
    panel: fingerprint(repoRoot, pair.panel.files),
    global: fingerprint(deps.read().configRoot, pair.global.files),
  });

  /** Сверка в фоне; вторая просьба во время идущей — та же сверка. */
  function start(pair: PairEntry, manual: boolean): Promise<void> {
    const existing = running.get(pair.id);
    if (existing) return existing;
    if (manual) {
      const state = loadState();
      if (state[pair.id]?.changed) {
        delete state[pair.id]!.changed;
        saveState(state);
      }
    }
    const job = compare({ pair, configRoot: deps.read().configRoot, repoRoot })
      .then((result) => {
        const state = loadState();
        // Отметка правки переживает автоматическую сверку: её должен увидеть человек.
        const changed = manual ? undefined : state[pair.id]?.changed;
        state[pair.id] = { ...result, comparedAt: now(), ...(changed ? { changed } : {}) };
        saveState(state);
        errors.delete(pair.id);
      })
      .catch((error: unknown) => {
        errors.set(pair.id, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        running.delete(pair.id);
        deps.onChange();
      });
    running.set(pair.id, job);
    deps.onChange();
    return job;
  }

  /** Сторона изменилась после сверки — отметить и перезапустить сверку. */
  function checkChanged(pair: PairEntry): void {
    if (running.has(pair.id)) return;
    const state = loadState();
    const last = state[pair.id];
    if (!last) {
      void start(pair, false);
      return;
    }
    const hashes = currentHashes(pair);
    const sides = (['panel', 'global'] as const).filter(
      (side) => hashes[side] !== last.hashes[side],
    );
    if (sides.length === 0) return;
    const known = last.changed?.sides ?? [];
    last.changed = { at: now(), sides: [...new Set([...known, ...sides])] };
    saveState(state);
    void start(pair, false);
  }

  function proposalCount(pair: PairEntry): number {
    const dir = proposalDir(pair.id);
    return pair.global.files.filter((file) => existsSync(join(dir, file))).length;
  }

  function view(pair: PairEntry, state: PairState | undefined): GlobalLayerPairView {
    const error = errors.get(pair.id);
    return {
      id: pair.id,
      title: pair.title,
      panelFiles: pair.panel.files,
      globalFiles: pair.global.files,
      comparing: running.has(pair.id),
      rows: state?.rows ?? [],
      cases: state?.cases ?? 0,
      proposalFiles: proposalCount(pair),
      ...(state ? { comparedAt: state.comparedAt, panel: state.panel, global: state.global } : {}),
      ...(state?.changed ? { changed: state.changed } : {}),
      ...(error ? { error } : {}),
    };
  }

  return {
    list(): GlobalLayerPairView[] {
      for (const pair of registry) checkChanged(pair);
      const state = loadState();
      return registry.map((pair) => view(pair, state[pair.id]));
    },

    /** Ручная сверка: снимает отметку правки. */
    compare(id: string): GlobalLayerPairView {
      const pair = pairOf(id);
      void start(pair, true);
      return view(pair, loadState()[id]);
    },

    /** Дождаться идущей сверки — для тестов и CLI. */
    settled(id: string): Promise<void> {
      return running.get(id) ?? Promise.resolve();
    },

    /** Файл глобального слоя изменился — наблюдатель за конфигурацией. */
    onGlobalChanged(): void {
      for (const pair of registry) checkChanged(pair);
    },

    proposal(id: string): GlobalLayerProposal {
      const pair = pairOf(id);
      const dir = proposalDir(id);
      const files = pair.global.files
        .filter((file) => existsSync(join(dir, file)))
        .map((file) => {
          const before = readText(join(deps.read().configRoot, file));
          const after = readFileSync(join(dir, file), 'utf8');
          const diff = diffLines(before, after);
          return {
            path: file,
            beforeSha: sha(before),
            afterSha: sha(after),
            isNew: !existsSync(join(deps.read().configRoot, file)),
            added: diff.added,
            removed: diff.removed,
            lines: diff.lines,
          };
        });
      return { files };
    },

    /**
     * Записать подтверждённые файлы предложения в слой. Отпечатки — то, что
     * человек видел: файл слоя или предложение сдвинулись после показа — отказ,
     * а не запись непросмотренного.
     */
    apply(id: string, request: GlobalLayerApplyRequest): GlobalLayerApplyResponse {
      const pair = pairOf(id);
      const { configRoot, backupDir } = deps.read();
      const dir = proposalDir(id);
      const planned = request.files.map((file) => {
        if (!pair.global.files.includes(file.path) || !existsSync(join(dir, file.path))) {
          throw new GlobalLayerError('not-in-pair', `${file.path} is not a proposal of ${id}`);
        }
        const target = join(configRoot, file.path);
        const after = readFileSync(join(dir, file.path), 'utf8');
        if (sha(readText(target)) !== file.beforeSha || sha(after) !== file.afterSha) {
          throw new GlobalLayerError(
            'stale-proposal',
            `${file.path} changed after the diff was shown`,
          );
        }
        return { path: file.path, target, after };
      });
      const written: string[] = [];
      const backups: string[] = [];
      for (const item of planned) {
        mkdirSync(join(item.target, '..'), { recursive: true });
        const backup = writeTextFile(item.target, item.after, {
          backupDir,
          backupName: `global-layer__${item.path.replace(/[\\/]/g, '__')}`,
        });
        if (backup) backups.push(backup);
        written.push(item.path);
        rmSync(join(dir, item.path), { force: true });
      }
      void start(pair, false);
      return { written, backups };
    },

    transfer(id: string, request: GlobalLayerTransferRequest): GlobalLayerTransferResponse {
      const pair = pairOf(id);
      const dir = proposalDir(id);
      if (request.direction === 'toGlobal') mkdirSync(dir, { recursive: true });
      return {
        prompt: transferPrompt({
          pair,
          request,
          rows: loadState()[id]?.rows ?? [],
          configRoot: deps.read().configRoot,
          repoRoot,
          proposalDir: dir,
          corpus: corpusPath(pair),
        }),
        cwd: repoRoot,
      };
    },
  };
}

export type GlobalLayer = ReturnType<typeof createGlobalLayer>;
