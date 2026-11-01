import { join } from 'node:path';
import {
  HOOK_OBSERVATIONS_MAX,
  type HookObservation,
  type SkillMode,
  type UserLayerInventory,
} from '@agentdeck/contracts/core/user-layer';
import type { AdapterCaps, CliAdapter, LayerRun } from '../../adapters/adapter.types.ts';
import { decideLayerRun } from '../../adapters/layer-run/decide.ts';
import { openRecorderLog } from '../../adapters/layer-run/recorder.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readCoreConfig } from '../../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { OsKind } from '../../platform/os-kind.ts';
import { samePath } from '../../platform/paths.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Слой человека в журнале сеанса (P87, G7, G-b): отметка доверия панели, опись и её хеш
 * (`layer.changed`), решение `layer-run`, потери частей (`signal layer-loss`) и сводка записи
 * хуков `observe` (`layer.observed`). Дорога сессии зовёт это на старте и на конце сеанса.
 */

/** Журнал записи хуков `observe` в каталоге сеанса (его пишет `run.ts recorder`). */
export const HOOKS_LOG = 'hooks.log';

/**
 * Отметка доверия панели (03:44): исходный репозиторий есть в `config.trustedRepos`. Настройки
 * не прочлись — отметки нет (доверие решит запись самого CLI), причина — вызывающему.
 */
export function panelTrusted(
  layout: Pick<CoreHomeLayout, 'config'>,
  sourceRepo: string,
  os: OsKind,
): { mark: boolean; unread?: string } {
  const read = readCoreConfig(layout);
  if ('unknown' in read) return { mark: false, unread: read.unknown };
  if ('absent' in read) return { mark: false };
  const repos = read.value.doc.trustedRepos ?? [];
  return { mark: repos.some((repo) => samePath(repo, sourceRepo, os)) };
}

export interface LayerStartInput {
  task: LiveTask;
  stepId: string;
  sessionId: string;
  dir: string;
  cli: string;
  caps: Pick<AdapterCaps, 'skillControl'>;
  /** Опись слоя переходника (`CliAdapter.inventory`); нет — опись неизвестна. */
  inventoryOf?: CliAdapter['inventory'];
  pin: Record<string, string>;
  cwd: string;
  skills: SkillMode;
  layer: LayerRun;
}

/**
 * Старт сеанса: опись → `layer.changed`, если хеш другой (первый сеанс CLI в задаче — тоже);
 * решение `layer-run`; каждая потеря — сигнал `layer-loss` (warn). В `observe` заводится пустой
 * журнал записи: сводка на конце пишется и тогда, когда ни один хук не сработал. Опись — вызывающему:
 * дорога держит её для судьи права и крана слоя, второй раз файлы слоя не читаются.
 */
export function journalLayerStart(input: LayerStartInput): UserLayerInventory | null {
  const { task, stepId, sessionId } = input;
  const inventory = input.inventoryOf?.(input.pin, input.cwd, input.layer.repoLayer) ?? null;
  const hash = inventory?.hash ?? null;
  // Последний хеш этого CLI — из свёртки журнала задачи: перезапуск ядра его не теряет.
  if (hash !== null && task.state.layerHashes[input.cli] !== hash) {
    task.append({
      kind: 'layer.changed',
      actor: 'core',
      stepId,
      sessionId,
      data: { userLayerHash: hash },
    });
  }
  const decision = decideLayerRun({
    layer: input.layer,
    skills: input.skills,
    caps: input.caps,
    inventoryHash: hash,
    cli: input.cli,
  });
  task.append({
    kind: 'decision',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      decisionId: newId(),
      class: 'layer-run',
      inputs: [],
      facts: [{ readClass: 'user-layer-inventory', kind: inventory ? 'value' : 'unknown' }],
      numbers: {
        hooks: inventory?.hooks.length ?? 0,
        skills: inventory?.skills.length ?? 0,
        agents: inventory?.agents.length ?? 0,
        unread: inventory?.unread.length ?? 0,
      },
      reasons: decision.detail,
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  });
  for (const loss of input.layer.losses ?? []) {
    task.append({
      kind: 'signal',
      actor: 'core',
      stepId,
      sessionId,
      data: { signal: 'layer-loss', severity: 'warn', subject: sessionId, detail: loss },
    });
  }
  if (input.layer.ran === 'observe') openRecorderLog(join(input.dir, HOOKS_LOG));
  return inventory;
}

/**
 * Конец сеанса: сводка журнала записи по хукам (`layer.observed`, ≤200 строк). Журнала нет —
 * сеанс шёл не в `observe`, писать нечего; строка не JSON — сбой этого хука, а не тишина.
 * Журнал есть, но не прочёлся — это не «нет журнала» (F25): сводка с одной строкой-ошибкой.
 */
export function journalLayerObserved(task: LiveTask, sessionId: string, dir: string): void {
  const got = readBytesSync(join(dir, HOOKS_LOG));
  if (!('value' in got) && !('unknown' in got)) return;
  const text = 'value' in got ? got.value.toString('utf8') : '';
  const byHook = new Map<string, HookObservation>();
  if ('unknown' in got) {
    byHook.set('unreadable', {
      hook: 'unreadable',
      event: 'unknown',
      calls: 1,
      wouldBlock: 0,
      errors: 1,
    });
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: { hook?: unknown; event?: unknown; decision?: unknown };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      line = { hook: 'unreadable', event: 'unknown', decision: 'error' };
    }
    const hook = typeof line.hook === 'string' && line.hook ? line.hook : 'unknown';
    const event = typeof line.event === 'string' && line.event ? line.event : 'unknown';
    const row = byHook.get(hook) ?? { hook, event, calls: 0, wouldBlock: 0, errors: 0 };
    row.calls++;
    if (line.decision === 'wouldBlock') row.wouldBlock++;
    else if (line.decision !== 'allow') row.errors++;
    byHook.set(hook, row);
  }
  task.append({
    kind: 'layer.observed',
    actor: 'core',
    sessionId,
    data: { sessionId, observations: [...byHook.values()].slice(0, HOOK_OBSERVATIONS_MAX) },
  });
}
