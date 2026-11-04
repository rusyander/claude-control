import { join } from 'node:path';
import type { AskBody, AskImage, AskJournal, AskReply } from '@agentdeck/contracts/core/ask';
import { sniffAgentImage } from '@agentdeck/contracts/agent-images';
import { ASK_PRESET } from '@agentdeck/contracts/core/ask';
import type { ScenarioRef } from '@agentdeck/contracts/core/scenario';
import { decideTier } from '../../economy/tier.ts';
import type { OverrideRow } from '../../economy/tier.types.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createExclusive } from '../../platform/safe-io/files.ts';
import type { SetRoutePorts } from '../commands/commands.types.ts';
import { decideSetRoute } from '../commands/set-route.ts';
import { REQUEST_ARTIFACT, taskOfOrigin, type SplitEnv } from '../estimate/index.ts';
import { resolveScenario, scenarioPrecedence } from '../scenario/index.ts';
import { envNamesProblems } from '../task-env/index.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { AskBridgeBook } from './bridge-book.ts';

/**
 * Лёгкая сессия «ask» (этап 10, F2): задача сценария `ask@1` одним путём, без репозитория, без
 * предпроверки дорог git и без единицы 0 — один шаг чата, который ядро закрывает на конце
 * первого хода. Суд маршрута — тот же, что у любой сессии: набор маршрутов задачи берётся из
 * той же настройки, что у оценки, и переходник, названный панелью, судится `tier` до создания
 * строки правки (вне набора — 422, задачи нет). Токен моста панели — в книгу в памяти, не в журнал.
 */

export const ASK_SYSTEM_ARTIFACT = 'system.md';
/** Каталог картинок вопроса в каталоге задачи; CLI получает их блоками `image` первого хода. */
export const ASK_IMAGES_DIR = 'ask-images';
const EXT: Record<AskImage['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const ASK_REF: ScenarioRef = { id: ASK_PRESET, version: 1 };
/** Уровень живого хода человека (06 §Precedence): выбор маршрутов в панели — тот же, что `set-route`. */
const SET_ROUTE_LEVEL = 2;

export type AskOutcome =
  { status: 200 | 202; reply: AskReply } | { status: 422; problems: string[] };

export function replayAsk(registry: TaskRegistry, cmdId: string): AskReply | undefined {
  const known = taskOfOrigin(registry, cmdId);
  return known ? { taskId: known, replayed: true } : undefined;
}

/**
 * Картинки вопроса: байты сверены с объявленным типом (блок с чужим типом API модели отвергает
 * весь ход — отказ здесь, до задачи); имена файлов — по порядку, без имени человека в пути.
 */
function askImagesOf(
  images: readonly AskImage[] | undefined,
):
  | { ok: true; files: { image: AskImage; file: string; bytes: Buffer }[] }
  | { ok: false; problems: string[] } {
  const files: { image: AskImage; file: string; bytes: Buffer }[] = [];
  const problems: string[] = [];
  for (const [i, image] of (images ?? []).entries()) {
    const bytes = Buffer.from(image.base64, 'base64');
    const sniffed = sniffAgentImage(bytes);
    if (sniffed !== image.mediaType) {
      problems.push(
        `images[${i}]: bytes are ${sniffed ?? 'not an image'}, declared ${image.mediaType}`,
      );
      continue;
    }
    files.push({ image, file: `${ASK_IMAGES_DIR}/${i}${EXT[image.mediaType]}`, bytes });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

function askJournalOf(
  body: AskBody,
  images: { image: AskImage; file: string; bytes: Buffer }[],
): AskJournal {
  const f = body.fields;
  return {
    tools: f.tools,
    ...(images.length > 0
      ? {
          images: images.map(({ image, file, bytes }) => ({
            name: image.name,
            mediaType: image.mediaType,
            file,
            bytes: bytes.length,
          })),
        }
      : {}),
    ...(f.consumer ? { consumer: f.consumer } : {}),
    ...(f.panelBridge
      ? {
          bridge: {
            url: f.panelBridge.url,
            ...(f.panelBridge.conversation ? { conversation: f.panelBridge.conversation } : {}),
          },
        }
      : {}),
  };
}

/** Переходник панели — судом `tier` над пробной строкой: тот же суд, что у `set-cli` (G9). */
function adapterProblem(task: LiveTask, adapter: string): string | null {
  const { state } = task;
  if (!state.created) return 'task is not created';
  const trial: OverrideRow[] = [
    {
      seq: state.seq + 1,
      scope: 'task',
      scopeId: state.taskId,
      timing: 'now',
      field: 'adapter',
      value: adapter,
    },
  ];
  const d = decideTier({
    taskId: state.taskId,
    unitId: null,
    stepId: null,
    stepModel: { tier: 'ceiling' },
    allowed: allowedRoutesOf(state),
    ceiling: state.created.modelCeiling,
    overrides: trial,
  });
  return d.ok ? null : `adapter ${adapter}: ${d.reasons.join('; ')}`;
}

function failCreated(task: LiveTask, cmdId: string, reason: string): void {
  const moved = task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'fail', from: task.state.task, to: 'failed' },
  });
  task.append({
    kind: 'task.ended',
    actor: 'core',
    cmdId,
    cause: moved.seq,
    data: { outcome: 'failed' },
  });
  task.append({
    kind: 'signal',
    actor: 'core',
    cmdId,
    data: { signal: 'ask-refused', severity: 'warn', subject: 'ask', detail: reason },
  });
}

/**
 * Набор вопроса (G13) — тот же суд имён, что у оценки (`envNamesProblems`): значение у каждого
 * имени, имя у каждого значения, ни одной переменной ядра; книги нет — значения некуда положить.
 */
function askSessionProblems(body: AskBody, env: SplitEnv): string[] {
  const session = body.fields.session;
  const values = body.env ?? {};
  if (!session) {
    return Object.keys(values).length > 0 ? ['env: values without fields.session.env names'] : [];
  }
  const out = envNamesProblems(session.env ?? [], values);
  if (session.env && !env.taskEnv)
    out.push('session.env: this core has no task env book to hold the values');
  return out;
}

export async function createAskTask(
  body: AskBody,
  registry: TaskRegistry,
  env: SplitEnv,
  bridges: AskBridgeBook,
  routePorts?: () => SetRoutePorts | undefined,
): Promise<AskOutcome> {
  const known = taskOfOrigin(registry, body.cmdId);
  if (known) return { status: 200, reply: { taskId: known, replayed: true } };
  const { fields, cmdId } = body;
  const images = askImagesOf(fields.images);
  if (!images.ok) return { status: 422, problems: images.problems };
  const session = askSessionProblems(body, env);
  if (session.length > 0) return { status: 422, problems: session };
  const scenario = await resolveScenario(ASK_REF, [], { libraryDir: env.libraryDir });
  if (!scenario.ok) {
    return { status: 422, problems: scenario.refusals.map((r) => `scenario: ${r.reason}`) };
  }
  const launch = env.allowedRoutes();
  let routes = launch;
  if (fields.routes) {
    // Выбор человека в панели — тот же суд, что у `set-route` (уровень 2): реестр этой загрузки и
    // обязательный контур. Нет портов маршрутов — выбор не судим, значит и не принят.
    const ports = routePorts?.();
    if (!ports) return { status: 422, problems: ['routes: route registry is not wired'] };
    const decided = decideSetRoute(launch.routes, fields.routes, ports);
    if (!decided.ok) {
      return { status: 422, problems: decided.reasons.map((r) => `${decided.code}: ${r}`) };
    }
    routes = { routes: decided.allowedRoutes, level: SET_ROUTE_LEVEL };
  }
  const task = await registry.create({
    title: fields.title,
    repos: [],
    build: env.build,
    scenario: ASK_REF,
    profilePins: [],
    modelCeiling: fields.model ?? null,
    userLayerHash: null,
    envPin: '',
    requirementsSource: REQUEST_ARTIFACT,
    allowedRoutes: routes.routes,
    routesSourceLevel: routes.level,
    origin: { cmdId },
    launchPolicy: 'auto',
    ciWait: false,
    placement: 'scratch',
    ask: askJournalOf(body, images.files),
    // Набор панели чужому CLI (G13): имена и дописка — в журнал, значения — только в книгу.
    ...(fields.session ? { session: fields.session } : {}),
  });
  if (body.env && fields.session?.env) env.taskEnv?.put(task.taskId, body.env);
  // Токен — до первой строки, которую видит дирижёр: сессия не стартует без своего моста.
  if (fields.panelBridge) bridges.put(task.taskId, fields.panelBridge.token);
  // Под маской DLP, как запрос оценки: секрет из вопроса не ложится на диск открытым.
  createExclusive(join(task.dir, REQUEST_ARTIFACT), registry.mask(fields.prompt).text);
  if (fields.system) {
    createExclusive(join(task.dir, ASK_SYSTEM_ARTIFACT), registry.mask(fields.system).text);
  }
  for (const { file, bytes } of images.files) createExclusive(join(task.dir, file), bytes);
  task.append({
    kind: 'scenario.overlay',
    actor: 'core',
    cmdId,
    data: {
      scenario: ASK_REF,
      applied: scenario.overlay.applied,
      rejected: scenario.overlay.rejected,
    },
  });
  task.append({
    kind: 'decision',
    actor: 'core',
    cmdId,
    data: { decisionId: newId(), ...scenarioPrecedence(scenario, routes) },
  });
  if (fields.adapter) {
    const problem = adapterProblem(task, fields.adapter);
    if (problem) {
      failCreated(task, cmdId, problem);
      bridges.drop(task.taskId);
      return { status: 422, problems: [problem] };
    }
    task.append({
      kind: 'override.set',
      actor: 'core',
      cmdId,
      data: {
        cmdId,
        scope: 'task',
        scopeId: task.taskId,
        timing: 'now',
        field: 'adapter',
        value: fields.adapter,
      },
    });
  }
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  return { status: 202, reply: { taskId: task.taskId, replayed: false } };
}
