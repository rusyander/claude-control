import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresetId, StepDef } from '@agentdeck/contracts/core/scenario';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTask } from '../../conductor/estimate/index.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { PRESETS } from '../../conductor/scenario/index.ts';
import {
  estimateBody,
  gitRepo,
  testEnv,
  type TestEnv,
} from '../../conductor/split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { scenarioHooks, type ScenarioWiringDeps } from './scenario.ts';

/**
 * Проход по стенду (этап 12): адрес стенда, окружение, имена доступов и цель человека живут только
 * в запросе задачи (`request.md`, его пишет оценка из запроса панели). У сценария `browser-walk`
 * нет разбора, который перенёс бы запрос в требования, — бриф шага `walk` несёт запрос сам, словами
 * человека; иначе модель видит одну подпись задачи и открывает «/login» без стенда.
 */

const REQUEST = [
  'Walk the stand http://127.0.0.1:4321 (environment env-1) and do what the human asked:',
  'W3-LOGIN log in as demo',
  'Fill credentials only by secret name: STAND_PASSWORD.',
].join('\n');

let root: string;
let registry: TaskRegistry;
let env: TestEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-walk-request-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function stepOf(preset: PresetId, kind: string): StepDef {
  const def = PRESETS.find((p) => p.id === preset)?.steps.find((s) => s.kind === kind);
  if (!def) throw new Error(`no ${kind} step in ${preset}`);
  return def;
}

async function sectionsFor(preset: PresetId, kind: string) {
  const out = await estimateTask(
    estimateBody([gitRepo(root, `${preset}-${kind}`)], {
      title: 'Проход по стенду: W3-LOGIN',
      request: REQUEST,
      scenario: { preset },
    }),
    registry,
    env,
  );
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const s: StepCtx = {
    taskId: out.reply.taskId,
    unitId: 'u1',
    repoKey: 'r1',
    copyDir: null,
    stepId: 's1',
    def: stepOf(preset, kind),
    round: 0,
    sessionId: null,
  };
  const got = await scenarioHooks({ registry } as unknown as ScenarioWiringDeps).preStep?.(s);
  return got?.sections ?? [];
}

describe('browser-walk brief: the walk step carries the human request', () => {
  it('a walk step: the request text (stand URL, environment, secret names) is a human-message section beside the title', async () => {
    const sections = await sectionsFor('browser-walk', 'walk');
    expect(sections.find((x) => x.id === 'task')?.text).toBe('Проход по стенду: W3-LOGIN');
    expect(sections.find((x) => x.id === 'human-message')?.text).toBe(REQUEST);
  });

  it('a step whose scenario carries the request through intake (feature work) gets no extra copy of it', async () => {
    const sections = await sectionsFor('feature', 'work');
    expect(sections.map((x) => x.id)).not.toContain('human-message');
  });
});

/**
 * Разбор запроса (этап 12): шаг `intake` просят «перечислить каждый пункт запроса», а запрос живёт
 * только в `request.md`. Без его текста в брифе модель видит одну подпись задачи и выдумывает
 * требования по ней — бриф разбора несёт запрос словами человека, как и проход по стенду.
 */
describe('intake brief: the intake step carries the human request', () => {
  it.each(['feature', 'bug-fix'] as const)(
    '%s intake: the request text is a human-message section beside the title',
    async (preset) => {
      const sections = await sectionsFor(preset, 'intake');
      expect(sections.find((x) => x.id === 'task')?.text).toBe('Проход по стенду: W3-LOGIN');
      expect(sections.find((x) => x.id === 'human-message')?.text).toBe(REQUEST);
    },
  );

  it('the plan step after intake reads the extracted requirements, not a second copy of the request', async () => {
    const sections = await sectionsFor('feature', 'plan');
    expect(sections.map((x) => x.id)).not.toContain('human-message');
  });
});
