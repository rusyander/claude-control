import { z } from 'zod';
import type {
  PortHoldersInfo,
  ProjectFileContent,
  ProjectFileTree,
  ProjectRunnerInfo,
  ProjectRunnerTarget,
  ProjectRunnerView,
} from '@agentdeck/contracts';
import { maskSecretsInText, SECRET_MASK } from '../../lib/secret-mask.ts';
import { planTreeKill, readPosixProcessTable, readProcessTable } from '../../lib/kill-tree.mjs';
import { ancestorsOf } from '../../domains/analytics/session-process.ts';
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
  OFFSET_DESCRIPTION,
  readRoute,
  SECRET_REFUSAL,
  stateCard,
  textWindow,
} from './action-kit.ts';
import {
  copyRef,
  pageFor,
  projectRef,
  resolveTarget,
  samePath,
  targetLabel,
  type ProjectTarget,
} from './project-target.ts';
import { dataField, textField } from './texts.ts';

/**
 * Dev-серверы проекта и чтение его кода (U4a). Запуск исполняет код проекта,
 * автозапуск — ещё и без карточки при каждом следующем старте панели, поэтому
 * обе правки `danger` и карточка называет команду целиком. Код агент только
 * читает: запись файлов проекта — у человека в окне кода. Всё прочитанное
 * проходит маску секретов, а блоки PEM прячутся целиком — детектор строк их не
 * видит.
 */

const runnerTargetInput = {
  project: projectRef,
  copy: copyRef,
  dir: z
    .string()
    .trim()
    .optional()
    .describe(
      'Target folder relative to the project (a monorepo package) from describe_project_runner; omit = root',
    ),
};

const describeUrl = (dir: string) => `/api/project-runner/describe?path=${encode(dir)}`;

const readRunner = (inject: InjectRoute, dir: string) =>
  readRoute<ProjectRunnerInfo>(inject, describeUrl(dir));

const readRunning = (inject: InjectRoute) =>
  readRoute<ProjectRunnerView[]>(inject, '/api/project-runner');

/** Хвост вывода dev-сервера для модели: коротко и маской. */
const OUTPUT_TAIL = 2000;

const shownRunning = (view: ProjectRunnerView) => ({
  dir: view.dir,
  name: view.name,
  status: view.status,
  command: maskSecretsInText(view.command),
  ...(view.port !== undefined ? { port: view.port } : {}),
  ...(view.url ? { url: view.url } : {}),
  ...(view.error ? { error: maskSecretsInText(view.error) } : {}),
  ...(view.busyPort !== undefined ? { busyPort: view.busyPort } : {}),
  ...(view.output ? { output: maskSecretsInText(view.output.slice(-OUTPUT_TAIL)) } : {}),
});

const shownTarget = (target: ProjectRunnerTarget) => ({
  dir: target.dir,
  name: target.name,
  runnable: target.runnable,
  ...(target.command ? { command: maskSecretsInText(target.command) } : {}),
  ...(target.reason ? { reason: target.reason } : {}),
  ...(target.commandOverride ? { commandOverride: maskSecretsInText(target.commandOverride) } : {}),
  ...(target.pinnedPort !== undefined ? { pinnedPort: target.pinnedPort } : {}),
  ...(target.lastPort !== undefined ? { lastPort: target.lastPort } : {}),
  autostart: target.autostart,
});

const describeProjectRunner = definePanelAction({
  name: 'describe_project_runner',
  section: 'projects',
  risk: 'read',
  description:
    'Dev-server targets of a project (or one of its working copies): root and monorepo packages with their ' +
    'command, pinned port and autostart, plus which of them run now (status, url, error, output tail).',
  input: z.object({ project: projectRef, copy: copyRef }),
  route: async (input, inject) => ({
    method: 'GET',
    url: describeUrl((await resolveTarget(inject, input)).dir),
  }),
  afterRoute: async (_input, body, inject) => ({
    info: body as ProjectRunnerInfo,
    running: await readRunning(inject),
  }),
  shape: (_input, body) => {
    const { info, running } = body as { info: ProjectRunnerInfo; running: ProjectRunnerView[] };
    return {
      targets: info.targets.map(shownTarget),
      running: running
        .filter((view) => samePath(view.projectPath, info.projectPath))
        .map(shownRunning),
      ...(info.skipped > 0 ? { skipped: info.skipped } : {}),
    };
  },
  summary: 'journal-project-runner',
});

/** Цель запуска по подпапке или отказ со списком того, что есть. */
async function runnerTarget(
  inject: InjectRoute,
  input: { project: string; copy?: string; dir?: string },
): Promise<{ target: ProjectTarget; runner: ProjectRunnerTarget }> {
  const target = await resolveTarget(inject, input);
  const info = await readRunner(inject, target.dir);
  const wanted = (input.dir ?? '').replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  const runner = info.targets.find((item) => item.dir === wanted);
  if (!runner) {
    throw new Error(
      `No dev-server target «${wanted || '(root)'}» here; targets: ${info.targets
        .map((item) => item.dir || '(root)')
        .join(', ')}.`,
    );
  }
  return { target, runner };
}

const contentUrl = (dir: string, file: string) =>
  `/api/project-files/content?path=${encode(dir)}&file=${encode(file)}`;

type Scripts = Record<string, unknown> | null;

/**
 * Скрипты `package.json` цели. `npm run dev` в карточке ничего не говорит о том,
 * что исполнится: тело скрипта — строкой ниже в файле, и человек мог его
 * поменять, пока карточка ждёт (ревью U4a m2). Нет файла или он не JSON —
 * `null`: запускать там нечего, и карточка это скажет сама.
 */
async function packageScripts(
  inject: InjectRoute,
  target: ProjectTarget,
  runner: ProjectRunnerTarget,
): Promise<Scripts> {
  const file = runner.dir ? `${runner.dir}/package.json` : 'package.json';
  try {
    const content = await readRoute<ProjectFileContent>(inject, contentUrl(target.dir, file));
    const parsed = JSON.parse(content.content) as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === 'object'
      ? (parsed.scripts as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `npm run dev`, `pnpm dev`, `yarn start -- --port 1` → имя скрипта. */
const SCRIPT_COMMAND = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.@/-]+)(?:\s|$)/;

/**
 * Какой скрипт исполнит команда и его тело. `command === ''` — возврат к
 * скрипту пакета (как выбирает запуск: `dev`, иначе `start`).
 */
function scriptOf(command: string | undefined, scripts: Scripts): string | undefined {
  let name: string | undefined;
  if (command === '') name = ['dev', 'start'].find((item) => typeof scripts?.[item] === 'string');
  else if (command) name = SCRIPT_COMMAND.exec(command.trim())?.[1];
  const body = name ? scripts?.[name] : undefined;
  return typeof body === 'string' ? `${name}: ${maskSecretsInText(body)}` : undefined;
}

const scriptField = (command: string | undefined, scripts: Scripts) => {
  const line = scriptOf(command, scripts);
  return line ? [dataField('label-project-runner-script', line)] : [];
};

/** Отпечаток цели запуска: её настройки и скрипты пакета, которые она исполнит. */
async function runnerState(
  inject: InjectRoute,
  input: { project: string; copy?: string; dir?: string },
) {
  const { target, runner } = await runnerTarget(inject, input);
  return { target, runner, scripts: await packageScripts(inject, target, runner) };
}

const runnerPrint = async (
  inject: InjectRoute,
  input: { project: string; copy?: string; dir?: string },
) => {
  const { runner, scripts } = await runnerState(inject, input);
  return fingerprintOf({ runner, scripts });
};

const runnerName = (target: ProjectTarget, runner: ProjectRunnerTarget) =>
  runner.dir ? `${target.project.name} / ${runner.name}` : target.project.name;

function checkedCommand(command: string | undefined): string | undefined {
  if (command && literalSecrets({ command }).length > 0) {
    throw new Error(`command: ${SECRET_REFUSAL}`);
  }
  return command;
}

const saveProjectRunnerSettings = definePanelAction({
  name: 'save_project_runner_settings',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-runner-settings',
  description:
    'Change a dev-server target without starting it: command ("" = back to the package script) and/or a ' +
    'pinned port (null = unpin). The command runs on the next start, and by itself when autostart is on. Needs confirmation.',
  input: z.object({
    ...runnerTargetInput,
    command: z.string().max(2000).optional(),
    port: z.number().int().min(1).max(65_535).nullable().optional(),
  }),
  route: async (input, inject) => {
    const { target, runner } = await runnerTarget(inject, input);
    return {
      method: 'POST',
      url: '/api/project-runner/settings',
      body: {
        path: target.dir,
        dir: runner.dir,
        ...(input.command !== undefined ? { command: checkedCommand(input.command) } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
      },
    };
  },
  fingerprint: (input, inject) => runnerPrint(inject, input),
  preview: async (input, inject) => {
    const { target, runner, scripts } = await runnerState(inject, input);
    const command = checkedCommand(input.command);
    if (command === undefined && input.port === undefined) {
      throw new Error('Nothing would change: send command and/or port.');
    }
    return stateCard(
      `runner: ${runner.path}`,
      { command: runner.commandOverride ?? '', pinnedPort: runner.pinnedPort ?? null },
      {
        command: command ?? runner.commandOverride ?? '',
        pinnedPort: input.port === undefined ? (runner.pinnedPort ?? null) : input.port,
      },
      card('summary-project-runner-settings', { target: runnerName(target, runner) }),
      [
        dataField('label-project', targetLabel(target)),
        ...scriptField(command ?? runner.command, scripts),
        ...(runner.autostart ? [textField('label-warning', 'value-project-runner-autostart')] : []),
      ],
    );
  },
  shape: (_input, body) => ({
    targets: (body as ProjectRunnerInfo).targets.map(shownTarget),
  }),
  page: (input) => pageFor(input),
});

const setProjectRunnerAutostart = definePanelAction({
  name: 'set_project_runner_autostart',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-runner-autostart',
  description:
    'Turn autostart of a dev-server target on or off: when on, the panel starts it by itself on every next ' +
    'panel start, with no confirmation. Nothing starts or stops now. Needs confirmation.',
  input: z.object({ ...runnerTargetInput, enabled: z.boolean() }),
  route: async (input, inject) => {
    const { target, runner } = await runnerTarget(inject, input);
    return {
      method: 'POST',
      url: '/api/project-runner/autostart',
      body: { path: target.dir, dir: runner.dir, enabled: input.enabled },
    };
  },
  fingerprint: (input, inject) => runnerPrint(inject, input),
  preview: async (input, inject) => {
    const { target, runner, scripts } = await runnerState(inject, input);
    if (runner.autostart === input.enabled) {
      throw new Error('Nothing would change: autostart is already in that state.');
    }
    if (input.enabled && !runner.runnable) {
      throw new Error(`This target cannot start: ${runner.reason ?? 'no dev/start script'}.`);
    }
    return stateCard(
      `runner: ${runner.path}`,
      { autostart: runner.autostart },
      { autostart: input.enabled },
      card(
        input.enabled
          ? 'summary-project-runner-autostart-on'
          : 'summary-project-runner-autostart-off',
        { target: runnerName(target, runner) },
      ),
      [
        dataField('label-project', targetLabel(target)),
        ...(input.enabled
          ? [
              dataField('label-command', maskSecretsInText(runner.command ?? '')),
              ...scriptField(runner.command, scripts),
              textField('label-warning', 'value-project-runner-autostart'),
            ]
          : []),
      ],
    );
  },
  shape: (_input, body) => ({
    targets: (body as ProjectRunnerInfo).targets.map(shownTarget),
  }),
  page: (input) => pageFor(input),
});

const isAlive = (view: ProjectRunnerView) =>
  view.status === 'starting' || view.status === 'running';

async function runningOf(inject: InjectRoute, runner: ProjectRunnerTarget) {
  return (await readRunning(inject)).find((view) => samePath(view.path, runner.path));
}

const startProjectRunner = definePanelAction({
  name: 'start_project_runner',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-runner-start',
  description:
    'Start the dev server of a project target (runs project code on this machine). command overrides the ' +
    'package script and is remembered for next starts. Needs confirmation; the card shows the exact command.',
  input: z.object({ ...runnerTargetInput, command: z.string().trim().min(1).max(2000).optional() }),
  route: async (input, inject) => {
    const { target, runner } = await runnerTarget(inject, input);
    return {
      method: 'POST',
      url: '/api/project-runner/start',
      body: {
        path: target.dir,
        dir: runner.dir,
        ...(input.command ? { command: checkedCommand(input.command) } : {}),
      },
    };
  },
  fingerprint: async (input, inject) => {
    const { runner, scripts } = await runnerState(inject, input);
    const running = await runningOf(inject, runner);
    return fingerprintOf({ runner, scripts, status: running?.status ?? null });
  },
  preview: async (input, inject) => {
    const { target, runner, scripts } = await runnerState(inject, input);
    const command = checkedCommand(input.command) ?? runner.command;
    if (!command) {
      throw new Error(`This target cannot start: ${runner.reason ?? 'no dev/start script'}.`);
    }
    const running = await runningOf(inject, runner);
    if (running && isAlive(running)) {
      throw new Error(`The dev server of this target is already ${running.status}.`);
    }
    return {
      ...card('summary-project-runner-start', { target: runnerName(target, runner) }),
      fields: [
        dataField('label-project', targetLabel(target)),
        dataField('label-directory', runner.path),
        dataField('label-command', maskSecretsInText(command)),
        ...scriptField(command, scripts),
        ...(runner.pinnedPort !== undefined
          ? [dataField('label-project-runner-port', String(runner.pinnedPort))]
          : []),
      ],
    };
  },
  shape: (_input, body) => shownRunning(body as ProjectRunnerView),
  page: (input) => pageFor(input),
});

const stopProjectRunner = definePanelAction({
  name: 'stop_project_runner',
  section: 'projects',
  risk: 'change',
  title: 'journal-project-runner-stop',
  description:
    'Stop the running dev server of a project target (kills its process tree). Needs confirmation.',
  input: z.object(runnerTargetInput),
  route: async (input, inject) => {
    const { target, runner } = await runnerTarget(inject, input);
    return {
      method: 'POST',
      url: '/api/project-runner/stop',
      body: { path: target.dir, dir: runner.dir },
    };
  },
  fingerprint: async (input, inject) => {
    const { runner } = await runnerTarget(inject, input);
    const running = await runningOf(inject, runner);
    return fingerprintOf(running ? [running.path, running.startedAt, running.status] : null);
  },
  preview: async (input, inject) => {
    const { target, runner } = await runnerTarget(inject, input);
    const running = await runningOf(inject, runner);
    if (!running || !isAlive(running)) {
      throw new Error('Nothing would change: this dev server is not running.');
    }
    return stateCard(
      `runner: ${runner.path}`,
      { status: running.status, ...(running.port !== undefined ? { port: running.port } : {}) },
      { status: 'stopped' },
      card('summary-project-runner-stop', { target: runnerName(target, runner) }),
      [dataField('label-project', targetLabel(target))],
    );
  },
  page: (input) => pageFor(input),
});

const portUrl = (port: number) => `/api/project-runner/port?port=${port}`;

/** Сам сервер панели и его родитель (сторож) — их агент не гасит никогда. */
const PANEL_PIDS = new Set([process.pid, process.ppid]);

/**
 * Порты стенда панели: сервер и фронт этого процесса (`PORT`/`WEB_PORT`) и
 * порты по умолчанию — стенд владельца, даже когда агент работает во
 * временной панели рядом. Фронт — не потомок сервера (оба — дети `pnpm dev`),
 * поэтому по дереву процессов его не узнать; по порту — да (ревью U4a m6).
 */
function standPorts(): Set<number> {
  const ports = [5178, 8888, Number(process.env.PORT), Number(process.env.WEB_PORT)];
  return new Set(ports.filter((port) => Number.isInteger(port) && port > 0));
}

/**
 * Дерево процесса панели: предки (сторож, `pnpm`, оболочка) и потомки (CLI
 * чатов, MCP, запущенные панелью dev-серверы). Снятие держателя гасит и его
 * дерево, так что предок в списке — это сама панель. `undefined` — снимка нет:
 * тогда отказ, «не выяснили» не значит «не наш».
 */
function panelTree(): Set<number> | undefined {
  const table = process.platform === 'win32' ? readProcessTable() : readPosixProcessTable();
  if (!table) return undefined;
  return new Set([
    ...PANEL_PIDS,
    ...ancestorsOf(table, process.pid),
    ...planTreeKill(table, process.pid, { selfPid: -1 }).pids,
  ]);
}

/** Отказ до карточки и перед исполнением: порт стенда или держатель из дерева панели. */
function guardPanel(port: number, info: PortHoldersInfo): void {
  if (info.holders.some((holder) => PANEL_PIDS.has(holder.pid))) {
    throw new Error(`Port ${port} is held by the panel itself; the agent never stops it.`);
  }
  if (standPorts().has(port)) {
    throw new Error(`Port ${port} serves the panel stand; the agent never frees it.`);
  }
  if (info.holders.length === 0) return;
  const tree = panelTree();
  if (!tree) {
    throw new Error(
      `Cannot tell right now which processes belong to the panel, so port ${port} is not freed. Try again.`,
    );
  }
  const own = info.holders.filter((holder) => tree.has(holder.pid));
  if (own.length > 0) {
    throw new Error(
      `Port ${port} is held by a process that belongs to the panel (pid ${own
        .map((holder) => holder.pid)
        .join(
          ', ',
        )}); the agent never stops it. A dev server the panel started stops with stop_project_runner.`,
    );
  }
}

async function portHolders(inject: InjectRoute, port: number): Promise<PortHoldersInfo> {
  return readRoute<PortHoldersInfo>(inject, portUrl(port));
}

async function guardedHolders(inject: InjectRoute, port: number): Promise<PortHoldersInfo> {
  const info = await portHolders(inject, port);
  guardPanel(port, info);
  return info;
}

const holdersText = (info: PortHoldersInfo) =>
  info.holders
    .map(
      (holder) =>
        `${holder.pid}${holder.name ? ` ${holder.name}` : ''}${holder.ours ? ' (dev server of the panel)' : ''}`,
    )
    .join('\n');

const freePort = definePanelAction({
  name: 'free_port',
  section: 'projects',
  risk: 'danger',
  title: 'journal-project-free-port',
  description:
    'Free a TCP port by stopping the processes listening on it (e.g. a stale dev server). The card lists ' +
    'those processes. Refused for the panel’s own ports and processes (a dev server the panel started stops ' +
    'with stop_project_runner). Needs confirmation.',
  input: z.object({ port: z.number().int().min(1).max(65_535) }),
  route: async (input, inject) => {
    await guardedHolders(inject, input.port);
    return { method: 'POST', url: '/api/project-runner/free-port', body: { port: input.port } };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf(
      (await portHolders(inject, input.port)).holders.map((holder) => holder.pid).sort(),
    ),
  preview: async (input, inject) => {
    const info = await guardedHolders(inject, input.port);
    if (!info.busy || info.holders.length === 0) {
      throw new Error(`Nothing would change: nobody listens on port ${input.port}.`);
    }
    return {
      ...card('summary-project-free-port', { port: input.port }),
      fields: [
        dataField('label-project-runner-port', String(input.port)),
        dataField('label-project-port-holders', holdersText(info)),
      ],
    };
  },
  shape: (_input, body) => body as PortHoldersInfo,
});

// --- Код проекта: только чтение ---

const listProjectFiles = definePanelAction({
  name: 'list_project_files',
  section: 'projects',
  risk: 'read',
  description:
    'List one folder of a project (or one of its working copies): names, relative paths, sizes. dir = relative ' +
    'folder, omit = root. Read-only: the agent never writes project code.',
  input: z.object({
    project: projectRef,
    copy: copyRef,
    dir: z.string().trim().max(1000).optional(),
  }),
  route: async (input, inject) => ({
    method: 'GET',
    url: `/api/project-files/tree?path=${encode((await resolveTarget(inject, input)).dir)}&dir=${encode(input.dir ?? '')}`,
  }),
  shape: (_input, body) => {
    const tree = body as ProjectFileTree;
    return {
      dir: tree.dir,
      entries: tree.entries.map((entry) => ({
        path: entry.path,
        isDir: entry.isDir,
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
      })),
      ...(tree.truncated ? { truncated: true } : {}),
    };
  },
  summary: 'journal-project-files',
});

/** Блок закрытого ключа прячется целиком: строки base64 детектор не узнаёт. */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;

export function maskCode(text: string): string {
  return maskSecretsInText(
    text.replace(
      PEM_BLOCK,
      (_block, kind: string) => `-----BEGIN ${kind}-----\n${SECRET_MASK}\n-----END ${kind}-----`,
    ),
  );
}

const readProjectFile = definePanelAction({
  name: 'read_project_file',
  section: 'projects',
  risk: 'read',
  description:
    'Read one file of a project (or one of its working copies) by relative path, in windows of ~15000 chars; ' +
    'pass nextOffset to continue. Secret values are masked. Read-only: the human edits code in the code window.',
  input: z.object({
    project: projectRef,
    copy: copyRef,
    file: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('Path relative to the project root, "/" separators'),
    offset: z.number().int().nonnegative().default(0).describe(OFFSET_DESCRIPTION),
  }),
  route: async (input, inject) => ({
    method: 'GET',
    url: `/api/project-files/content?path=${encode((await resolveTarget(inject, input)).dir)}&file=${encode(input.file)}`,
  }),
  shape: (input, body) => {
    const file = body as ProjectFileContent;
    return {
      path: file.path,
      sizeBytes: file.sizeBytes,
      ...(file.isBinary
        ? { isBinary: true, ...(file.preview ? { preview: file.preview } : {}) }
        : textWindow(maskCode(file.content), input.offset)),
    };
  },
  summary: 'journal-project-file-read',
});

/** Dev-серверы и код проекта в порядке показа: чтения, затем записи. */
export const PROJECT_RUNNER_ACTIONS: readonly AnyPanelAction[] = [
  describeProjectRunner,
  listProjectFiles,
  readProjectFile,
  saveProjectRunnerSettings,
  setProjectRunnerAutostart,
  startProjectRunner,
  stopProjectRunner,
  freePort,
];
