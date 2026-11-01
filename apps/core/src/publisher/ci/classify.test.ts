import { readFileSync } from 'node:fs';
import type { CiClass, ForgeJob, ForgePipeline } from '@agentdeck/contracts/core/forge';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { githubJob } from '../../adapters/forge/github-map.ts';
import { gitlabJob } from '../../adapters/forge/gitlab-map.ts';
import { createForgePort } from '../../adapters/forge/index.ts';
import { classifyCi, classifyJob } from './index.ts';

/**
 * P30: класс CI по записанным ответам GitLab и GitHub — через те же функции разбора, что и живой
 * порт, — и по конвейерам заглушки форжа через настоящий порт. Машина CI (не стартовало, умер
 * раннер, срок ушёл на подготовку) — `infra`; скрипт пошёл и покраснел — `code`; машина не
 * доказана — тоже `code`. Судит последний конвейер головы.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));

/** Логи таймаутов GitLab: раздел `step_script` есть — скрипт шёл; нет — срок ушёл на подготовку. */
const TRACES: Record<string, string> = {
  '9003':
    'section_start:1761818409:prepare_executor\nWaiting for pod… 0/30 nodes are available: 30 Insufficient cpu\n',
  '9004':
    'section_start:1761818409:prepare_executor\nsection_start:1761818420:step_script\n$ npm run e2e\n',
};

const GITLAB_TABLE: Record<string, CiClass> = {
  'unit-tests': 'code', // script_failure
  lint: 'infra', // runner_system_failure
  'semgrep-scan': 'infra', // timeout, log without step_script
  e2e: 'code', // timeout inside the script
  image: 'infra', // never started (started_at null)
  deps: 'code', // unknown_failure: the machine is not proven
  compile: 'green',
  integration: 'pending',
  'review-app': 'infra', // canceled before it ran
  fuzz: 'code', // timeout whose log was not read: not proven
};

const GITHUB_TABLE: Record<string, CiClass> = {
  'unit-tests': 'code', // a step past «Set up job» failed
  lint: 'infra', // only the runner setup ran
  e2e: 'infra', // cancelled
  build: 'green',
  'deploy-preview': 'pending',
  integration: 'code', // timed out inside the script step
};

describe('classifyCi over recorded job JSON (P30)', () => {
  it('GitLab jobs, mapped by the live gitlabJob, land in the expected class', () => {
    const raw = fixture('gitlab-jobs.json') as Record<string, unknown>[];
    const got: Record<string, CiClass> = {};
    for (const job of raw) {
      const mapped = gitlabJob(job, TRACES[String(job.id)]);
      if (!mapped) throw new Error(`fixture ${String(job.id)} unreadable`);
      got[mapped.name] = classifyJob(mapped);
    }
    expect(got).toEqual(GITLAB_TABLE);
  });

  it('GitHub jobs, mapped by the live githubJob, land in the expected class', () => {
    const raw = fixture('github-jobs.json') as { jobs: unknown[] };
    const got: Record<string, CiClass> = {};
    for (const job of raw.jobs) {
      const mapped = githubJob(job);
      if (!mapped) throw new Error('fixture job unreadable');
      got[mapped.name] = classifyJob(mapped);
    }
    expect(got).toEqual(GITHUB_TABLE);
  });
});

const SHA = 'f'.repeat(40);
const job = (over: Partial<ForgeJob>): ForgeJob => ({
  id: '1',
  name: 'test',
  status: 'success',
  failureReason: null,
  startedAt: 1,
  scriptStarted: true,
  ...over,
});
const pipe = (id: string, createdAt: number, jobs: ForgeJob[], sha = SHA): ForgePipeline => ({
  id,
  sha,
  status: 'failed',
  createdAt,
  jobs,
});
const INFRA = job({
  status: 'failed',
  failureReason: 'runner_system_failure',
  scriptStarted: false,
});
const CODE = job({ status: 'failed', failureReason: 'script_failure' });

describe('classifyCi: which pipeline and which job decides', () => {
  it('the latest pipeline of the head sha decides, in any read order; a tie goes to the larger id', () => {
    const red = pipe('10', 100, [INFRA]);
    const green = pipe('11', 200, [job({})]);
    expect(classifyCi([red, green], SHA).class).toBe('green');
    expect(classifyCi([green, red], SHA)).toMatchObject({ class: 'green', pipelineId: '11' });
    expect(classifyCi([pipe('9', 100, [job({})]), pipe('12', 100, [CODE])], SHA).class).toBe(
      'code',
    );
  });

  it('other shas are ignored; none for the head is none', () => {
    expect(classifyCi([pipe('1', 1, [CODE], 'a'.repeat(40))], SHA)).toMatchObject({
      class: 'none',
      pipelineId: null,
    });
  });

  it('code wins over running jobs; infra waits until nothing runs; jobless red is code', () => {
    const running = job({ status: 'running', scriptStarted: null });
    expect(classifyCi([pipe('1', 1, [CODE, running])], SHA).class).toBe('code');
    expect(classifyCi([pipe('1', 1, [INFRA, running])], SHA).class).toBe('pending');
    expect(classifyCi([pipe('1', 1, [INFRA, job({})])], SHA)).toMatchObject({
      class: 'infra',
      reasons: ['test: failed (runner_system_failure)'],
    });
    expect(classifyCi([pipe('1', 1, [])], SHA).class).toBe('code');
  });
});

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

describe.each(['gitlab', 'github'] as const)(
  'classifyCi over the %s port (stub scenarios)',
  (kind) => {
    it.each([
      ['mr-red-never-settles-green', 'green'],
      ['ci-code-red', 'code'],
      ['ci-infra-timeout', 'infra'],
      ['ci-pending', 'pending'],
    ] as const)('%s → %s', async (scenario, want) => {
      stub = await startStubForge({ scenario });
      const port = createForgePort({
        project: { kind, ref: 'acme/app', baseUrl: stub.url, pushUrl: `${stub.url}/acme/app.git` },
        token: stub.tokens.publisher!,
        fetch: globalThis.fetch,
      });
      const mr = await port.createMr({
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
      });
      if (!('value' in mr)) throw new Error('stub MR not created');
      const head = mr.value.headSha ?? '0'.repeat(40);
      const pipelines = await port.pipelines({ sha: head });
      if (!('value' in pipelines)) throw new Error('pipelines unreadable');
      expect(classifyCi(pipelines.value, head).class).toBe(want);
    });
  },
);
