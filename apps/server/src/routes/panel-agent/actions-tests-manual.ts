import { z } from 'zod';
import type {
  ProjectTestBaseline,
  ProjectTestE2eFolder,
  ProjectTestManualSession,
  ProjectTestsView,
} from '@agentdeck/contracts';
import {
  attachmentFile,
  buildPoints,
  planCases,
  selectCases,
} from '../../domains/project-tests.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import {
  card,
  encode,
  literalSecrets,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
} from './action-kit.ts';
import { dataField, summaryText, textField } from './texts.ts';
import { testsPage, testsQuery as query } from './tests-page.ts';
import { idOf, named, projectPath, STATUS_WORDS, viewOf } from './tests-block-kit.ts';

/**
 * Ручной прогон, эталоны снимков и автотесты папки e2e руками агента.
 *
 * Ручной прогон проходит ЧЕЛОВЕК: агент заводит сессию, записывает результат,
 * который человек назвал словами («третий кейс упал, кнопка молчит»), и
 * закрывает прогон. Выдумывать результат агенту нечем — у него нет ни экрана,
 * ни браузера, и описание каждого действия это повторяет.
 *
 * Снимок на сравнение с эталоном (`POST /baseline`) агенту не дан: это
 * PNG-файл из браузера, а у агента нет ни картинки, ни файловой системы.
 * Принять уже снятый снимок эталоном — дано, опасным: прежний эталон
 * заменяется, и вернуть его из панели нельзя.
 */

// ─── Ручной прогон ─────────────────────────────────────────────────────────

const manualOf = async (inject: InjectRoute, path: string) =>
  (
    await readRoute<{ session?: ProjectTestManualSession | null }>(
      inject,
      `/api/project-tests/manual?${query(path)}`,
    )
  ).session ?? undefined;

async function liveSession(inject: InjectRoute, path: string, runId?: string) {
  const session = await manualOf(inject, path);
  if (!session || session.finishedAt) {
    throw new Error('No manual run is going in this project. Start one with start_manual_run.');
  }
  if (runId && session.runId !== runId) {
    throw new Error(
      `Manual run «${runId}» is not the one going now («${session.runId}»). Read read_tests_report kind=manual.`,
    );
  }
  return session;
}

const startInput = z.object({
  projectPath,
  planId: z.string().trim().min(1).optional().describe('Run a saved plan'),
  groupId: z.string().trim().min(1).optional().describe('Run one group'),
  caseIds: z
    .array(z.string().trim().min(1))
    .max(1000)
    .optional()
    .describe('Only these cases (ids or "group:id")'),
  environmentId: z.string().trim().min(1).optional(),
});
type StartInput = z.infer<typeof startInput>;

/**
 * Тест-поинты, которые заведёт сессия, — теми же функциями домена, что и
 * `ProjectTestManualRegistry.start`, по виду раздела, прочитанному маршрутом:
 * карточка называет ровно столько проходов, сколько появится.
 */
function pointsOf(view: ProjectTestsView, input: StartInput) {
  const plan = input.planId ? view.plans.find((item) => item.id === input.planId) : undefined;
  if (input.planId && !plan) {
    throw new Error(`Test plan «${input.planId}» not found. Call read_tests_report kind=plans.`);
  }
  if (input.groupId && !view.groups.some((group) => group.id === input.groupId)) {
    throw new Error(`Test group «${input.groupId}» not found. Call list_test_groups.`);
  }
  const chosen = plan
    ? planCases(view.groups, plan)
    : selectCases(view.groups, {
        groupIds: input.groupId ? [input.groupId] : undefined,
      }).filter(
        (item) =>
          !input.caseIds?.length ||
          input.caseIds.includes(item.testCase.id) ||
          input.caseIds.includes(`${item.groupId}:${item.testCase.id}`),
      );
  if (chosen.length === 0) throw new Error('Nothing to run: the selection has no cases.');
  return buildPoints(chosen, view.environments, { plan, environmentId: input.environmentId });
}

const startManualRun = definePanelAction({
  name: 'start_manual_run',
  section: 'tests',
  risk: 'change',
  title: 'journal-start-manual-run',
  description:
    'Start a MANUAL run the human will pass (by plan, group or listed cases; optional environment). ' +
    'Each case × environment becomes a test point. Only one manual run per project at a time. ' +
    'Then record the results the human reports with record_manual_result. Needs confirmation.',
  input: startInput,
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/manual/start',
    body: { path: input.projectPath, ...named({ ...input, projectPath: undefined }) },
  }),
  fingerprint: async (input, inject) => {
    const [view, session] = await Promise.all([
      viewOf(inject, input.projectPath),
      manualOf(inject, input.projectPath),
    ]);
    return fingerprintOf({
      points: pointsOf(view, input).map((point) => point.id),
      running: session && !session.finishedAt ? session.runId : null,
    });
  },
  preview: async (input, inject) => {
    const session = await manualOf(inject, input.projectPath);
    if (session && !session.finishedAt) {
      throw new Error(
        `A manual run is already going (${session.runId}, ${session.results.length} of ` +
          `${session.points.length} marked). Finish or cancel it first.`,
      );
    }
    const points = pointsOf(await viewOf(inject, input.projectPath), input);
    return stateCard(
      '.agent/tests/runs/(manual)',
      {},
      { points: points.map((point) => `${point.groupId}/${point.caseId} ${point.title}`) },
      card('summary-start-manual-run', { count: points.length }),
      [
        dataField('label-project', input.projectPath),
        ...(input.environmentId ? [dataField('label-environment', input.environmentId)] : []),
      ],
    );
  },
  shape: (_input, body) => {
    const session = (body as { session: ProjectTestManualSession }).session;
    return {
      runId: session.runId,
      points: session.points.map((point) => ({
        pointId: point.id,
        groupId: point.groupId,
        caseId: point.caseId,
        title: point.title,
        ...(point.environmentId ? { environmentId: point.environmentId } : {}),
      })),
    };
  },
  page: (input) => testsPage(input.projectPath, 'runs'),
});

const recordInput = z.object({
  projectPath,
  pointId: z.string().trim().min(1).optional().describe('Test point id from the manual run'),
  caseId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Instead of pointId, when the case has exactly one point in this run'),
  status: z.enum(['passed', 'failed', 'blocked', 'skipped', 'unknown']),
  note: z.string().trim().max(4000).optional().describe('What the human saw, in their words'),
  attachments: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe('Paths returned by attach_test_note'),
});
type RecordInput = z.infer<typeof recordInput>;

function pointOf(session: ProjectTestManualSession, input: RecordInput) {
  if (input.pointId) {
    const point = session.points.find((item) => item.id === input.pointId);
    if (!point) throw new Error(`Point «${input.pointId}» is not in the manual run.`);
    return point;
  }
  if (!input.caseId) throw new Error('Name the pointId (or the caseId) to mark.');
  const points = session.points.filter((item) => item.caseId === input.caseId);
  if (points.length === 0) throw new Error(`Case «${input.caseId}» is not in the manual run.`);
  if (points.length > 1) {
    throw new Error(
      `Case «${input.caseId}» has ${points.length} points in this run (environments or parameters): ` +
        `pass pointId, one of ${points.map((item) => item.id).join(', ')}.`,
    );
  }
  return points[0]!;
}

const recordManualResult = definePanelAction({
  name: 'record_manual_result',
  section: 'tests',
  risk: 'change',
  title: 'journal-record-manual-result',
  description:
    'Record the result of ONE test point of the manual run, exactly as the human reported it (you ' +
    'cannot check the app yourself — never invent a result). The status is written at once into ' +
    'the case and the run record. Needs confirmation.',
  input: recordInput,
  route: async (input, inject) => {
    const session = await liveSession(inject, input.projectPath);
    return {
      method: 'POST',
      url: '/api/project-tests/manual/result',
      body: {
        path: input.projectPath,
        runId: session.runId,
        pointId: pointOf(session, input).id,
        status: input.status,
        ...named({ note: input.note, attachments: input.attachments }),
      },
    };
  },
  // Отпечаток — прежняя отметка этого поинта: человек, отметивший его сам
  // после показа карточки, не получает затёртый результат.
  fingerprint: async (input, inject) => {
    const session = await liveSession(inject, input.projectPath);
    const point = pointOf(session, input);
    return fingerprintOf({
      runId: session.runId,
      result: session.results.find((item) => item.pointId === point.id) ?? null,
    });
  },
  preview: async (input, inject) => {
    const session = await liveSession(inject, input.projectPath);
    const point = pointOf(session, input);
    const previous = session.results.find((item) => item.pointId === point.id);
    const words = STATUS_WORDS[input.status]!;
    return stateCard(
      `${point.groupId}/${point.caseId}${point.environmentId ? `@${point.environmentId}` : ''}`,
      previous ? { status: previous.status, note: previous.note ?? '' } : { status: 'unknown' },
      { status: input.status, note: input.note ?? '' },
      summaryText(
        'summary-record-manual-result',
        { title: point.title, status: words.ru },
        { title: point.title, status: words.en },
      ),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (_input, body) => {
    const session = (body as { session: ProjectTestManualSession }).session;
    const next = session.points.find(
      (point) => !session.results.some((done) => done.pointId === point.id),
    );
    return {
      marked: session.results.length,
      total: session.points.length,
      next: next ? { pointId: next.id, title: next.title } : null,
    };
  },
  page: (input) => testsPage(input.projectPath, 'runs'),
});

const closeRun = (kind: 'finish' | 'cancel') =>
  definePanelAction({
    name: kind === 'finish' ? 'finish_manual_run' : 'cancel_manual_run',
    section: 'tests',
    risk: 'change',
    title: kind === 'finish' ? 'journal-finish-manual-run' : 'journal-cancel-manual-run',
    description:
      kind === 'finish'
        ? 'Finish the manual run: its record closes as done, the report stays. Needs confirmation.'
        : 'Abandon the manual run: it is recorded as stopped; results marked so far stay. Needs confirmation.',
    input: z.object({ projectPath }),
    route: async (input, inject) => ({
      method: 'POST',
      url: `/api/project-tests/manual/${kind}`,
      body: {
        path: input.projectPath,
        runId: (await liveSession(inject, input.projectPath)).runId,
      },
    }),
    fingerprint: async (input, inject) => {
      const session = await liveSession(inject, input.projectPath);
      return fingerprintOf({ runId: session.runId, marked: session.results.length });
    },
    preview: async (input, inject) => {
      const session = await liveSession(inject, input.projectPath);
      const params = { done: session.results.length, total: session.points.length };
      return stateCard(
        `.agent/tests/runs/${session.runId}`,
        { status: 'running', ...params },
        { status: kind === 'finish' ? 'done' : 'stopped', ...params },
        card(kind === 'finish' ? 'summary-finish-manual-run' : 'summary-cancel-manual-run', params),
        [dataField('label-project', input.projectPath)],
      );
    },
    shape: (_input, body) => {
      const session = (body as { session?: ProjectTestManualSession | null }).session;
      return session
        ? { runId: session.runId, finishedAt: session.finishedAt ?? null }
        : { closed: true };
    },
    page: (input) => testsPage(input.projectPath, 'runs'),
  });

/** Текстовые доказательства — то, что агент способен написать сам. */
const TEXT_ATTACHMENT = /\.(txt|log|md|json)$/i;
const MAX_NOTE_CHARS = 200_000;

async function caseTitle(inject: InjectRoute, path: string, caseId: string) {
  for (const group of (await viewOf(inject, path)).groups) {
    const found = group.cases.find((item) => item.id === caseId);
    if (found) return found.title;
  }
  throw new Error(`Case «${caseId}» not found. Call list_cases.`);
}

/**
 * Время карточки вложения по входу: исполнитель разбирает вход один раз и тот же
 * объект отдаёт карточке и маршруту, так что файл получает имя, показанное в
 * карточке, а не время клика. Нет записи (вызов мимо карточки) — текущее время.
 */
const cardTime = new WeakMap<object, string>();

const attachTestNote = definePanelAction({
  name: 'attach_test_note',
  section: 'tests',
  risk: 'change',
  title: 'journal-attach-test-note',
  description:
    'Attach a TEXT file (.txt .log .md .json) to a case as evidence: a log excerpt or notes the ' +
    'human gave you. Screenshots are attached by the human in the panel. Returns the file path to ' +
    'pass in record_manual_result attachments. Needs confirmation.',
  input: z.object({
    projectPath,
    caseId: idOf('Case id'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(TEXT_ATTACHMENT, 'Only .txt .log .md .json')
      .describe('File name, e.g. console.log'),
    text: z.string().min(1).max(MAX_NOTE_CHARS),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/attachment',
    body: {
      path: input.projectPath,
      caseId: input.caseId,
      name: input.name,
      contentBase64: Buffer.from(input.text, 'utf8').toString('base64'),
      at: cardTime.get(input) ?? new Date().toISOString(),
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(await caseTitle(inject, input.projectPath, input.caseId)),
  preview: async (input, inject) => {
    // Файл ляжет в репозиторий проекта: живой секрет в нём — утечка в историю git.
    if (literalSecrets({ text: input.text }).length > 0) throw new Error(SECRET_REFUSAL);
    const title = await caseTitle(inject, input.projectPath, input.caseId);
    const at = new Date().toISOString();
    cardTime.set(input, at);
    return stateCard(
      attachmentFile(input.caseId, input.name, at),
      {},
      { name: input.name, text: input.text },
      card('summary-attach-test-note', { name: input.name, title }),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (_input, body) => ({ file: (body as { file?: string }).file ?? null }),
});

// ─── Эталоны снимков ───────────────────────────────────────────────────────

async function baselineOf(inject: InjectRoute, path: string, caseId: string, pointId: string) {
  const { baselines } = await readRoute<{ baselines: ProjectTestBaseline[] }>(
    inject,
    `/api/project-tests/baselines?${query(path)}&caseId=${encode(caseId)}`,
  );
  const found = baselines.find((item) => item.pointId === pointId);
  if (!found) {
    throw new Error(
      `No baseline for case «${caseId}» point «${pointId}». Read read_tests_report kind=baselines.`,
    );
  }
  if (!found.actualFile) {
    throw new Error(
      'Nothing to accept: there is no newer snapshot that differs from the baseline for this point.',
    );
  }
  return found;
}

const acceptBaseline = definePanelAction({
  name: 'accept_baseline',
  section: 'tests',
  risk: 'danger',
  title: 'journal-accept-baseline',
  description:
    'Accept the latest snapshot of a visual check as the new baseline (case + point from ' +
    'read_tests_report kind=baselines, where the status is diff or error). The previous baseline ' +
    'is replaced and cannot be restored from the panel — do it only when the human says the new ' +
    'look is correct. Needs confirmation.',
  input: z.object({ projectPath, caseId: idOf('Case id'), pointId: idOf('Test point id') }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/baseline/accept',
    body: { path: input.projectPath, caseId: input.caseId, pointId: input.pointId },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(await baselineOf(inject, input.projectPath, input.caseId, input.pointId)),
  preview: async (input, inject) => {
    const baseline = await baselineOf(inject, input.projectPath, input.caseId, input.pointId);
    const title = await caseTitle(inject, input.projectPath, input.caseId).catch(
      () => input.caseId,
    );
    return stateCard(
      baseline.file,
      { baseline: baseline.file, status: baseline.status },
      { baseline: baseline.actualFile, status: 'match' },
      card('summary-accept-baseline', { title }),
      [
        dataField('label-project', input.projectPath),
        ...(baseline.diffRatio !== undefined
          ? [dataField('label-baseline-diff', `${(baseline.diffRatio * 100).toFixed(2)}%`)]
          : []),
        textField('label-warning', 'value-baseline-replace'),
      ],
    );
  },
  shape: (_input, body) => {
    const baseline = (body as { baseline?: ProjectTestBaseline }).baseline;
    return { status: baseline?.status ?? null, file: baseline?.file ?? null };
  },
  page: (input) => testsPage(input.projectPath, 'runs'),
});

// ─── Автотесты папки e2e ───────────────────────────────────────────────────

const folderOf = (inject: InjectRoute, path: string) =>
  readRoute<ProjectTestE2eFolder>(inject, `/api/project-tests/e2e?${query(path)}`);

const syncE2eTests = definePanelAction({
  name: 'sync_e2e_tests',
  section: 'tests',
  risk: 'change',
  title: 'journal-sync-e2e',
  description:
    'Sync the project’s e2e test folder with the cases: new tests become cases, known ones get their ' +
    'link. `dir` = choose the folder (monorepo: one of the folder `candidates`); the choice is ' +
    'remembered. Refused while the test agent writes the groups. Needs confirmation.',
  input: z.object({
    projectPath,
    dir: z.string().trim().min(1).optional().describe('Folder from read_tests_report kind=e2e'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/e2e/sync',
    body: { path: input.projectPath, ...named({ dir: input.dir }) },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await folderOf(inject, input.projectPath)),
  preview: async (input, inject) => {
    const folder = await folderOf(inject, input.projectPath);
    const dir = input.dir ?? folder.dir;
    if (!dir || (folder.state === 'missing' && !input.dir)) {
      throw new Error(
        'The project has no e2e folder yet' +
          (folder.candidates?.length
            ? `; pass dir, one of: ${folder.candidates.join(', ')}.`
            : '. The human creates one on the Testing page.'),
      );
    }
    return {
      ...card('summary-sync-e2e', { dir }),
      fields: [
        dataField('label-project', input.projectPath),
        dataField('label-e2e-folder', `${dir} (${folder.framework}, ${folder.specs})`),
      ],
    };
  },
  shape: (_input, body) => {
    const { sync } = body as { sync: Record<string, unknown> };
    return sync;
  },
  page: (input) => testsPage(input.projectPath, 'library'),
});

const runE2eInput = z.object({
  projectPath,
  environmentId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).optional().describe('Only autotests of this group'),
  caseIds: z
    .array(z.string().trim().min(1))
    .max(1000)
    .optional()
    .describe('Only autotests of these cases'),
});

function environmentField(view: ProjectTestsView, id: string | undefined) {
  if (!id) return [];
  const environment = view.environments.find((item) => item.id === id);
  if (!environment)
    throw new Error(`Environment «${id}» not found. Call read_tests_report kind=library-setup.`);
  return [
    dataField(
      'label-environment',
      environment.start ? `${environment.title} — ${environment.start}` : environment.title,
    ),
  ];
}

/** Кейсы выбора, у которых есть автотест: ровно их файлы уйдут в команду. */
function automatedOf(view: ProjectTestsView, input: z.infer<typeof runE2eInput>) {
  return view.groups
    .filter((group) => !input.groupId || group.id === input.groupId)
    .flatMap((group) => group.cases)
    .filter((item) => !input.caseIds?.length || input.caseIds.includes(item.id))
    .filter((item) => item.automation?.file);
}

const runE2eTests = definePanelAction({
  name: 'run_e2e_tests',
  section: 'tests',
  risk: 'danger',
  title: 'journal-run-e2e',
  description:
    'Run the project’s autotests on THIS machine: the e2e folder’s command (or the project’s own ' +
    'command), no agent, no tokens. Optional group/cases narrow it to their files. The result ' +
    'lands in the run history; read it with read_tests_report kind=e2e-run. Needs confirmation.',
  input: runE2eInput,
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/e2e/run',
    body: {
      path: input.projectPath,
      ...named({
        environmentId: input.environmentId,
        groupId: input.groupId,
        caseIds: input.caseIds,
      }),
    },
  }),
  fingerprint: async (input, inject) => {
    const view = await viewOf(inject, input.projectPath);
    return fingerprintOf({
      running: view.e2eRun?.status === 'running' ? view.e2eRun.startedAt : null,
      agentRun: view.run?.status === 'running' ? view.run.id : null,
      automation: view.automation ?? null,
      folder: view.e2e ? { dir: view.e2e.dir, specs: view.e2e.specs } : null,
      files: automatedOf(view, input).map((item) => item.automation?.file),
    });
  },
  preview: async (input, inject) => {
    const view = await viewOf(inject, input.projectPath);
    if (view.e2eRun?.status === 'running') {
      throw new Error('Autotests are already running in this project. Stop them first.');
    }
    const narrowed = Boolean(input.groupId || input.caseIds?.length);
    const cases = automatedOf(view, input);
    if (narrowed && cases.length === 0) {
      throw new Error(
        'None of the chosen cases has an autotest (automation.file): nothing to run.',
      );
    }
    return {
      ...(narrowed
        ? summaryText('summary-run-e2e-some', { count: cases.length })
        : summaryText('summary-run-e2e-all')),
      fields: [
        dataField('label-project', input.projectPath),
        ...(view.e2e?.dir
          ? [dataField('label-e2e-folder', `${view.e2e.dir} (${view.e2e.framework})`)]
          : []),
        ...(view.automation ? [dataField('label-command', view.automation.command)] : []),
        // Окружение со своей командой подъёма стенда — её человек тоже одобряет.
        ...environmentField(view, input.environmentId),
        textField('label-what-happens', 'value-e2e-run-happens'),
      ],
    };
  },
  shape: (_input, body) => {
    const run = (body as ProjectTestsView).e2eRun;
    return {
      run: run ? { status: run.status, command: run.command, startedAt: run.startedAt } : null,
    };
  },
  page: (input) => testsPage(input.projectPath, 'runs'),
});

const stopE2eTests = definePanelAction({
  name: 'stop_e2e_tests',
  section: 'tests',
  risk: 'change',
  title: 'journal-stop-e2e',
  description:
    'Stop the running autotests of a project; what reached the report is kept. Needs confirmation.',
  input: z.object({ projectPath }),
  route: (input) => ({
    method: 'POST',
    url: '/api/project-tests/e2e/run/stop',
    body: { path: input.projectPath },
  }),
  fingerprint: async (input, inject) => {
    const run = (await viewOf(inject, input.projectPath)).e2eRun;
    return fingerprintOf(run ? { startedAt: run.startedAt, status: run.status } : null);
  },
  preview: async (input, inject) => {
    const run = (await viewOf(inject, input.projectPath)).e2eRun;
    if (run?.status !== 'running') throw new Error('No autotest run is going in this project.');
    return stateCard(
      'tests/e2e-run',
      { status: run.status, command: run.command },
      { status: 'stopped', command: run.command },
      card('summary-stop-e2e'),
      [dataField('label-project', input.projectPath)],
    );
  },
  shape: (_input, body) => {
    const run = (body as ProjectTestsView).e2eRun;
    return { run: run ? { status: run.status } : null };
  },
  page: (input) => testsPage(input.projectPath, 'runs'),
});

export const TESTS_MANUAL_ACTIONS: readonly AnyPanelAction[] = [
  startManualRun,
  recordManualResult,
  closeRun('finish'),
  closeRun('cancel'),
  attachTestNote,
  acceptBaseline,
  syncE2eTests,
  runE2eTests,
  stopE2eTests,
];
