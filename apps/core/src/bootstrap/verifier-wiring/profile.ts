import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRegistry, Profile } from '@agentdeck/contracts/core/records';
import {
  machineProbes,
  runPreflight,
  type MachineProbeInput,
  type PreflightInput,
  type PreflightOptions,
  type PreflightProbes,
  type PreflightVerdict,
} from '../../conductor/preflight/index.ts';
import { engineRoadProbe } from '../../conductor/services.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { diskFree, diskVerdict, memFree, memVerdict, repoAccess } from '../../platform/machine.ts';
import { classifyEnv, rewriteEnv } from '../../verifier/env/index.ts';
import {
  profileMoved,
  profileOf,
  registryOf,
  type ProfileDeps,
  type RepoRef,
} from '../../verifier/profile/index.ts';

/**
 * Зона E: профиль, реестр проверок, окружение копии, факты машины, предполётная проверка.
 * Профили живут в доме ядра (`layout.profiles`), не в репозитории. Пробы чужих зон (CLI,
 * маршруты, MCP ядра, захват — зона D) вставляются в `preflight(..., extra)`; не вставленная —
 * `unknown('not wired')`, задача не стартует. Движок (зона F `engineRoadProbe`) вставлен здесь.
 */

export interface ProfileWiring {
  profileOf(repo: RepoRef): Promise<Fact<Profile>>;
  registryOf(repo: RepoRef): Promise<Fact<CheckRegistry>>;
  profileMoved(pinned: Pick<Profile, 'inputsFp'>, repo: RepoRef): ReturnType<typeof profileMoved>;
  classifyEnv: typeof classifyEnv;
  rewriteEnv: typeof rewriteEnv;
  machine: {
    diskFree: typeof diskFree;
    diskVerdict: typeof diskVerdict;
    memFree: typeof memFree;
    memVerdict: typeof memVerdict;
    repoAccess: typeof repoAccess;
  };
  preflight(
    input: PreflightInput & Omit<MachineProbeInput, 'diskPath'>,
    extra?: PreflightProbes,
    options?: PreflightOptions,
  ): Promise<PreflightVerdict>;
}

export function profileWiring(deps: { layout: CoreHomeLayout }): ProfileWiring {
  const profileDeps = (): ProfileDeps => ({ profilesDir: deps.layout.profiles });
  return {
    profileOf: (repo) => profileOf(repo, profileDeps()),
    registryOf: (repo) => registryOf(repo, profileDeps()),
    profileMoved: (pinned, repo) => profileMoved(pinned, repo, profileDeps()),
    classifyEnv,
    rewriteEnv,
    machine: { diskFree, diskVerdict, memFree, memVerdict, repoAccess },
    preflight: (input, extra = {}, options) =>
      runPreflight(
        input,
        {
          ...machineProbes({ ...input, diskPath: deps.layout.root }),
          // Движок контейнеров — проба зоны F: без неё дорога `container-engine` — «not wired».
          'container-engine': engineRoadProbe(),
          ...extra,
        },
        options,
      ),
  };
}
