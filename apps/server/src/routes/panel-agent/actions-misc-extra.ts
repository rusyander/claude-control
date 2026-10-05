import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type {
  PluginScaffoldResult,
  RunningAgent,
  SessionLocation,
  SessionStopResult,
} from '@agentdeck/contracts';
import type { BackupEntry } from '../../domains/backups.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, readRoute } from './action-kit.ts';
import { dataField, textField } from './texts.ts';

/**
 * Аналитика (идущие агенты, где идёт сессия, остановить её), удаление копии
 * и каркас плагина — маршрутами тех же кнопок.
 *
 * Стоп сессии открыт агенту только для процесса CLI вне панели, который панель
 * опознала и который НЕ держит саму панель: `allowPanel` не шлётся никогда —
 * снять собственного родителя решает только человек. Прогон чата панели
 * останавливается действиями чата, не отсюда.
 */

const liveAgents = definePanelAction({
  name: 'analytics_live',
  section: 'analytics',
  risk: 'read',
  description: 'Claude processes running on this machine right now: pid, name, memory, start time.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/analytics/live' }),
  shape: (_input, body) => {
    const live = body as { runningAgents: RunningAgent[]; at: string };
    return {
      at: live.at,
      count: live.runningAgents.length,
      agents: live.runningAgents.slice(0, 50),
    };
  },
  summary: 'journal-analytics-live',
});

const sessionSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f-]{8,64}$/i, 'session id (uuid)')
  .describe('Session id from the analytics sessions list');

const whereUrl = (id: string) => `/api/analytics/sessions/${encode(id)}/where`;
const readWhere = (inject: InjectRoute, id: string) =>
  readRoute<SessionLocation>(inject, whereUrl(id));

/** Где идёт сессия глазами модели: командная строка — через маску секретов. */
function whereView(location: SessionLocation) {
  const { where } = location;
  return {
    sessionId: location.sessionId,
    ...(location.projectPath ? { projectPath: location.projectPath } : {}),
    where:
      where.kind === 'process' ? { ...where, command: maskSecretsInText(where.command) } : where,
  };
}

const sessionWhere = definePanelAction({
  name: 'session_where',
  section: 'analytics',
  risk: 'read',
  description:
    'Where a Claude session runs now: panel (a chat of this panel), process (a CLI in a terminal ' +
    'or editor: pid, host), unidentified (writing, process unknown) or finished.',
  input: z.object({ sessionId: sessionSchema }),
  route: (input) => ({ method: 'GET', url: whereUrl(input.sessionId) }),
  shape: (_input, body) => whereView(body as SessionLocation),
  summary: 'journal-session-where',
});

/** Процесс, который можно снять, — или отказ словами, почему нельзя. */
async function stoppable(inject: InjectRoute, id: string) {
  const { where } = await readWhere(inject, id);
  if (where.kind === 'panel') {
    throw new Error('This session is a chat of the panel: stop it with the chat actions.');
  }
  if (where.kind === 'finished') throw new Error('Nothing to stop: the session is not running.');
  if (where.kind === 'unidentified') {
    throw new Error(
      'The session is being written, but its process is not identified: only the human can stop it.',
    );
  }
  if (where.ownsPanel) {
    throw new Error(
      'Stopping this process would also stop the panel itself: only the human decides that.',
    );
  }
  return where;
}

const STOP_OK: readonly SessionStopResult['result'][] = ['stopped', 'gone'];

const stopSession = definePanelAction({
  name: 'stop_session',
  section: 'analytics',
  risk: 'danger',
  title: 'journal-stop-session',
  description:
    'Stop a Claude session running OUTSIDE the panel (a CLI in a terminal or editor) with its ' +
    'child processes. Refused for panel chats, unidentified processes, and a process that hosts ' +
    'the panel. Needs the human’s confirmation.',
  input: z.object({ sessionId: sessionSchema }),
  route: async (input, inject) => {
    const where = await stoppable(inject, input.sessionId);
    return {
      method: 'POST',
      url: `/api/analytics/sessions/${encode(input.sessionId)}/stop`,
      body: { pid: where.pid, startedAt: where.startedAt },
    };
  },
  fingerprint: async (input, inject) => {
    const where = await stoppable(inject, input.sessionId);
    // Время создания — в отпечатке только там, где оно точное (Windows отдаёт
    // его из CIM). Вне Windows это `сейчас − возраст из ps` с точностью до
    // секунды: два чтения подряд дают разные миллисекунды, и отпечаток карточки
    // не сходился с отпечатком исполнения НИКОГДА — одобренный стоп всегда
    // уходил в «цель изменилась». Там номер сверяется с командой (в ней id
    // сессии, её же видел человек в карточке); время с допуском перед самим
    // снятием сверяет ещё и маршрут стопа.
    return fingerprintOf({
      pid: where.pid,
      command: where.command,
      ...(process.platform === 'win32' ? { startedAt: where.startedAt } : {}),
    });
  },
  preview: async (input, inject) => {
    const where = await stoppable(inject, input.sessionId);
    return {
      ...card('summary-stop-session', { session: input.sessionId.slice(0, 8) }),
      fields: [
        dataField(
          'label-process',
          `${where.pid} · ${where.editor ?? where.host} · ${maskSecretsInText(where.command).slice(0, 200)}`,
        ),
      ],
    };
  },
  refusal: (body) => {
    const result = body as SessionStopResult;
    return STOP_OK.includes(result.result)
      ? undefined
      : `The process was not stopped: ${result.result} (pid ${result.pid}).`;
  },
  shape: (_input, body) => body,
  page: () => ({ route: '/analytics' }),
});

async function findBackup(inject: InjectRoute, name: string): Promise<BackupEntry> {
  const { items } = await readRoute<{ items: BackupEntry[] }>(inject, '/api/backups');
  const entry = items.find((item) => item.name === name);
  if (!entry) throw new Error(`No backup «${name}». Call list_backups.`);
  return entry;
}

const deleteBackup = definePanelAction({
  name: 'delete_backup',
  section: 'history',
  risk: 'danger',
  title: 'journal-delete-backup',
  description:
    'Delete one backup copy for good: it can no longer be restored from. Needs the human’s ' +
    'confirmation.',
  input: z.object({ name: z.string().trim().min(1).describe('Backup name from list_backups') }),
  route: (input) => ({ method: 'DELETE', url: `/api/backups/${encode(input.name)}` }),
  fingerprint: async (input, inject) => fingerprintOf(await findBackup(inject, input.name)),
  preview: async (input, inject) => {
    const entry = await findBackup(inject, input.name);
    return {
      ...card('summary-delete-backup', { name: entry.name }),
      fields: [
        dataField('label-file', entry.target),
        dataField('label-created', entry.createdAt),
        textField('label-what-happens', 'value-delete-backup-effect'),
      ],
    };
  },
  shape: (input) => ({ deleted: input.name }),
  page: () => ({ route: '/history' }),
});

const COMPONENTS = ['commands', 'agents', 'skills', 'hooks'] as const;

const scaffoldInput = z.object({
  dir: z.string().trim().min(1).describe('Absolute path of an existing folder'),
  name: z.string().trim().min(1).max(64).describe('Plugin name: the folder and the manifest name'),
  description: z.string().trim().max(300).optional(),
  author: z.string().trim().max(100).optional(),
  commands: z.boolean().default(false),
  agents: z.boolean().default(false),
  skills: z.boolean().default(false),
  hooks: z.boolean().default(false),
});
type ScaffoldInput = z.infer<typeof scaffoldInput>;

const chosenParts = (input: ScaffoldInput) => COMPONENTS.filter((part) => input[part]);

/** Папка должна быть, папки плагина в ней — нет: чужое не перезаписываем. */
function scaffoldTarget(input: ScaffoldInput): string {
  if (!isAbsolute(input.dir) || !existsSync(input.dir)) {
    throw new Error(`"${input.dir}" is not an existing absolute folder.`);
  }
  const target = join(input.dir, input.name);
  if (existsSync(target)) {
    throw new Error(`"${target}" already exists: the agent never overwrites it.`);
  }
  return target;
}

const scaffoldPlugin = definePanelAction({
  name: 'scaffold_plugin',
  section: 'plugins',
  risk: 'change',
  title: 'journal-scaffold-plugin',
  description:
    'Create a plugin skeleton in a new sub-folder <name> of an existing folder: manifest and ' +
    'README always, plus the chosen parts (commands, agents, skills, hooks). Never overwrites an ' +
    'existing folder. Needs the human’s confirmation.',
  input: scaffoldInput,
  route: (input) => ({
    method: 'POST',
    url: '/api/plugins/scaffold',
    body: {
      dir: input.dir,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.author ? { author: input.author } : {}),
      components: Object.fromEntries(COMPONENTS.map((part) => [part, input[part]])),
    },
  }),
  fingerprint: (input) => fingerprintOf(scaffoldTarget(input)),
  preview: (input) => {
    const target = scaffoldTarget(input);
    const parts = chosenParts(input);
    return {
      ...card('summary-scaffold-plugin', { name: input.name }),
      fields: [
        dataField('label-directory', target),
        parts.length
          ? dataField('label-components', parts.join(', '))
          : textField('label-components', 'value-components-none'),
      ],
    };
  },
  refusal: (body) => {
    const result = body as PluginScaffoldResult;
    return result.ok ? undefined : `The skeleton was not created: ${result.error ?? 'refused'}`;
  },
  shape: (_input, body) => {
    const result = body as PluginScaffoldResult;
    return { path: result.path, created: result.created };
  },
  page: () => ({ route: '/plugins' }),
});

/** Аналитика, копии и каркас плагина сверх общих: в порядке показа. */
export const MISC_EXTRA_ACTIONS: readonly AnyPanelAction[] = [
  liveAgents,
  sessionWhere,
  stopSession,
  deleteBackup,
  scaffoldPlugin,
];
