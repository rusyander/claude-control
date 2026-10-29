import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Profile, ServiceEndpoint } from '@agentdeck/contracts/core/records';
import {
  prepareUnitCopy,
  removeUnitCopy,
  type ConfiguredInstall,
  type CopyPlaced,
  type CopyRemoveInput,
  type CopyRemoveResult,
  type CopySetupDecision,
  type MirrorSettings,
  type SetupDeps,
} from '../conductor/copy/index.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { CopyGitOptions } from '../platform/copy-git.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { readBaseEnv } from '../platform/base-env.ts';

/**
 * Копия единицы в сборе (04:97-99, G7): дирижёр зовёт `prepare` перед первым шагом единицы и
 * получает решение `copy-setup` (оно же уже в журнале) — `brief` кладётся в задание шага, провал
 * не прячется. `remove` — снятие по ресурсу (01 §Resources). Подключение — одна строка в
 * `boot-api.ts`: `copyWiring({ registry, layout, profileOf: verifier.profile.profileOf })`.
 */

export interface CopyWiringDeps {
  registry: Partial<Pick<TaskRegistry, 'live'>>;
  layout: Partial<Pick<CoreHomeLayout, 'logs'>>;
  profileOf(repo: { repoKey: string; path: string }): Promise<Fact<Profile>>;
  /** Свой корень копий вместо соседнего `<репозиторий>-worktrees` (тесты, настройка человека). */
  root?: string;
  git?: CopyGitOptions;
  /** Внешняя граница: запуск установщика. */
  install?: SetupDeps['install'];
  /** Окружение установки; по умолчанию — база ОС + PATH входной оболочки, один раз на ядро. */
  env?: () => Promise<Record<string, string>>;
}

export interface CopyPrepareOptions {
  endpoints?: readonly ServiceEndpoint[];
  settings?: MirrorSettings;
  configured?: ConfiguredInstall;
}

export interface CopyPrepared {
  decision: CopySetupDecision;
  placed?: CopyPlaced;
  /** `false` — решение уже было в журнале (возобновление), настройка не повторялась. */
  journaled: boolean;
}

export interface CopyWiring {
  prepare(
    taskId: string,
    unitId: string,
    options?: CopyPrepareOptions,
  ): Promise<Fact<CopyPrepared>>;
  remove(taskId: string, unitId: string, input: CopyRemoveInput): Promise<CopyRemoveResult>;
}

export function copyWiring(deps: CopyWiringDeps): CopyWiring {
  let pin: Promise<Record<string, string>> | undefined;
  function envPin(): Promise<Record<string, string>> {
    if (deps.env) return deps.env();
    pin ??= readBaseEnv({ temp: true });
    return pin;
  }

  return {
    async prepare(taskId, unitId, options = {}) {
      const task = deps.registry.live?.(taskId);
      if (!task) return { unknown: `task ${taskId} is not live in this core` };
      if (!deps.layout.logs) return { unknown: 'core home has no logs directory' };
      const prepared = await prepareUnitCopy(task, unitId, {
        profileOf: deps.profileOf,
        ...(deps.root ? { root: deps.root } : {}),
        ...(deps.git ? { git: deps.git } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.endpoints ? { endpoints: options.endpoints } : {}),
        ...(options.configured ? { configured: options.configured } : {}),
        setup: {
          env: await envPin(),
          logDir: join(deps.layout.logs, 'copy', taskId, unitId),
          ...(deps.install ? { install: deps.install } : {}),
        },
      });
      return { value: prepared };
    },
    async remove(taskId, unitId, input) {
      const task = deps.registry.live?.(taskId);
      if (!task) return { ok: false, refused: `task ${taskId} is not live in this core` };
      return removeUnitCopy(task, unitId, input);
    },
  };
}
