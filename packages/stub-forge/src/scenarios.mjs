/**
 * Сценарии заглушки форжа: что форж делает сам, когда публикатор открыл MR. Сценарий — набор
 * крючков над памятью (`state.hooks`), а не свой сервер (P120): тесты публикатора, стража и
 * сквозные прогоны берут одно и то же поведение по имени.
 */

/** Sha головы MR для конвейера; без репозитория у заглушки — нули, но тот же sha у всех чтений. */
const headSha = (mr) => mr.headSha ?? '0'.repeat(40);

/** Причины GitLab: раннер умер до скрипта (инфраструктура) и красный скрипт (код). */
const INFRA_JOB = {
  name: 'test',
  status: 'failed',
  failureReason: 'runner_system_failure',
  startedAt: null,
  scriptStarted: false,
};
const CODE_JOB = {
  name: 'test',
  status: 'failed',
  failureReason: 'script_failure',
  scriptStarted: true,
};
const TIMEOUT_JOB = {
  name: 'test',
  status: 'failed',
  failureReason: 'job_execution_timeout',
  scriptStarted: false,
};

export const REVIEW_THREAD_BODIES = Object.freeze([
  'Please rename `parseRow` to something that says what it returns.',
  'The empty input case has no test.',
]);

function onMrCreated(state, fn) {
  state.hooks.mrCreated.push(fn);
}

export const SCENARIOS = Object.freeze({
  /** Две открытые нити ревьюера уже есть, когда MR открылся: публикатор обязан прочитать их сам. */
  'review-threads-unseen': (state) =>
    onMrCreated(state, (mr) => {
      for (const body of REVIEW_THREAD_BODIES)
        state.addDiscussion(mr, state.user('reviewer').id, body);
    }),
  /**
   * Первый конвейер головы — красный на инфраструктуре, повтор — зелёный. Прочитавший первый
   * конвейер видит «красный навсегда»; прав только последний конвейер того же sha.
   */
  'mr-red-never-settles-green': (state) =>
    onMrCreated(state, (mr) => {
      const at = state.now();
      const sha = headSha(mr);
      state.addPipeline(mr.projectId, {
        sha,
        ref: mr.sourceBranch,
        status: 'failed',
        createdAt: at,
        jobs: [INFRA_JOB],
      });
      state.addPipeline(mr.projectId, {
        sha,
        ref: mr.sourceBranch,
        status: 'success',
        createdAt: at + 1,
        jobs: [{ name: 'test' }],
      });
    }),
  /** Скрипт задания упал — красный код. */
  'ci-code-red': (state) =>
    onMrCreated(state, (mr) =>
      state.addPipeline(mr.projectId, {
        sha: headSha(mr),
        ref: mr.sourceBranch,
        status: 'failed',
        jobs: [CODE_JOB],
      }),
    ),
  /** Таймаут, за который скрипт так и не начался (лог без `step_script`) — инфраструктура. */
  'ci-infra-timeout': (state) =>
    onMrCreated(state, (mr) =>
      state.addPipeline(mr.projectId, {
        sha: headSha(mr),
        ref: mr.sourceBranch,
        status: 'failed',
        jobs: [TIMEOUT_JOB],
      }),
    ),
  /** Конвейер ещё идёт. */
  'ci-pending': (state) =>
    onMrCreated(state, (mr) =>
      state.addPipeline(mr.projectId, {
        sha: headSha(mr),
        ref: mr.sourceBranch,
        status: 'running',
        jobs: [{ name: 'test', status: 'running', scriptStarted: true }],
      }),
    ),
  /** Форж видит конфликт с базой сразу при открытии. */
  'mr-conflict': (state) =>
    onMrCreated(state, (mr) => {
      mr.conflict = true;
    }),
});

export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

export function applyScenarios(state, names) {
  for (const name of [names ?? []].flat()) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new TypeError(`stub-forge: unknown scenario «${name}»`);
    scenario(state);
  }
}
