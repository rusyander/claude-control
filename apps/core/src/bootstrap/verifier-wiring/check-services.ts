import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Profile, ServiceRecipe } from '@agentdeck/contracts/core/records';
import type { CheckDeps } from '../../conductor/checks/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { mainWorktree } from '../../platform/copy-git.ts';
import { pathKey } from '../../platform/paths.ts';
import { rewriteEnv } from '../../verifier/env/index.ts';
import { profileOf, type ProfileDeps } from '../../verifier/profile/index.ts';
import type { ServicesWiring } from './services.ts';

/**
 * Сервисы проверки на пути очереди (C ↔ F ↔ E, 04:124, 04:93): рецепты — из профиля
 * репозиториев задачи (`profileOf` по `task.created.repos`), запуск — `ensureServices` зоны F
 * (один контейнер на задачу и рецепт, ресурс в журнале, снятие в конце задачи), адреса —
 * в файлы окружения копии (`rewriteEnv` зоны E), чтобы прогон говорил с контейнером задачи.
 * Непрочитанный профиль или файл окружения — причина, не «готово» (P58: зелёного без сервиса нет).
 */

export interface CheckServicesDeps {
  registry: Partial<Pick<TaskRegistry, 'live'>>;
  services: Pick<ServicesWiring, 'ensureServices'>;
  profilesDir: string;
  /** Подмена чтения дерева копии — только для тестов отказов (P44). */
  profileIo?: Pick<ProfileDeps, 'viewIo'>;
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

async function profilesOf(deps: CheckServicesDeps, taskId: string): Promise<Profile[]> {
  const repos = deps.registry.live?.(taskId)?.state.created?.repos ?? [];
  const out: Profile[] = [];
  for (const repo of repos) {
    // Путь репозитория задачи — копия: профиль читается без записи (A2-F08).
    const got = await profileOf(
      { repoKey: repo.repoKey, path: repo.path },
      { profilesDir: deps.profilesDir, ...deps.profileIo, write: () => undefined },
    );
    // Бросок — причина в ответе `ensureServices` (вход проверки ловит его как `unknown`).
    if (!('value' in got)) throw new Error(`profile of ${repo.repoKey}: ${why(got)}`);
    out.push(got.value);
  }
  return out;
}

export function checkServices(deps: CheckServicesDeps): NonNullable<CheckDeps['services']> {
  const ensure = deps.services.ensureServices(async (taskId): Promise<ServiceRecipe[]> =>
    (await profilesOf(deps, taskId)).flatMap((p) => p.serviceRecipes),
  );
  return async (req, needs) => {
    // Файлы окружения основной копии — человека (там адрес его базы): их не переписывают, а
    // проверка без переписанных адресов говорила бы с чужой базой — до запуска контейнера отказ.
    const main = await mainWorktree(req.copyDir);
    if (!('value' in main)) return { unknown: `copy env: worktree list: ${why(main)}` };
    if (pathKey(main.value) === pathKey(req.copyDir)) {
      return { unknown: `copy env: ${req.copyDir} is the main checkout, its env files stay as is` };
    }
    // Корни стеков — из профиля копии, прочитанного БЕЗ записи: общий `profiles/<repoKey>.json`
    // держит основную копию, а не копию посреди задачи (04:102). Непрочитан — `.env` стека
    // не найти, он держал бы адрес настоящей базы: причина до запуска контейнера.
    const profile = await profileOf(
      { repoKey: req.project, path: req.copyDir },
      { profilesDir: deps.profilesDir, ...deps.profileIo, write: () => undefined },
    );
    if (!('value' in profile)) return { unknown: `copy env: profile: ${why(profile)}` };
    const got = await ensure(req.taskId, needs);
    if (!('value' in got)) return got;
    const roots = profile.value.stacks.map((s) => s.root);
    const env = await rewriteEnv(req.copyDir, got.value, ['', ...roots]);
    if (!('value' in env)) return { unknown: `copy env: ${why(env)}` };
    return got;
  };
}
