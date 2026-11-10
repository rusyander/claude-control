import { join } from 'node:path';
import { siteBaseUrl, type ForgeInbox } from '@agentdeck/contracts/core/forge';
import { isKeysError } from '@agentdeck/keys/errors';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { readKeyStrict } from '@agentdeck/keys/provider-keys';
import { trimUrl } from '@agentdeck/trackers/client';
import { createForgeInbox } from '../adapters/forge/index.ts';
import { createJiraTracker, type CoreTracker } from '../adapters/tracker/index.ts';
import { createCaFetch } from '../platform/net/ca-fetch.ts';
import type { NetFetch } from '../platform/net/net.types.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { readPanelForge } from './panel-forge.ts';
import { INBOX_DEFAULTS } from '@agentdeck/contracts/core/inbox';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { boardFilePath, readBoardFile } from '../conductor/board/store.ts';
import { readHumanLedger } from '../conductor/human/ledger.ts';
import {
  raiseTrackerWriteAsk,
  trackerWriteApproval,
} from '../conductor/human/tracker-write-ask.ts';
import type { LiveTask } from '../journal/resume.ts';
import { readCoreConfig } from '../platform/core-config/read.ts';
import { layoutOf } from '../platform/core-home.ts';
import type { OutboxPort } from '../publisher/push/push.types.ts';
import type { TrackerCommentPort } from '../publisher/tracker-comment.ts';

/**
 * Трекер и входящие форжа по настройкам панели — ТОЛЬКО чтение (этап 12, D15, P165): сайт Jira и
 * GitLab — в открытом `state.json` панели (`settings.integrations`), значение доступа — в её
 * зашифрованном хранилище под `int:<вид>` (`@agentdeck/keys`). Ядро в каталог панели не пишет;
 * значение доступа живёт в замыкании порта и в заголовке запроса, наружу — только вид учётки
 * (`credential`) и причина с кодом.
 */

export type TrackerCredential = 'stored' | 'missing' | 'unreadable';

export interface PanelTrackerDeps {
  fetch?: NetFetch;
  caCertPath?: string;
  timeoutMs?: number;
}

export type PanelPort<P> = { port: P; credential: TrackerCredential } | { unknown: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Раздел `settings.integrations.jira` панели; нет каталога, файла или раздела — причина. */
export function readPanelJira(
  appData: string | null | undefined,
):
  | { value: { enabled: boolean; baseUrl: string; email: string; deployment: string } }
  | { unknown: string } {
  if (!appData) return { unknown: 'no panel data directory: tracker settings unread' };
  const file = join(appData, 'state.json');
  const bytes = readBytesSync(file);
  if ('absent' in bytes) return { unknown: 'panel state.json absent: jira is not configured' };
  if (!('value' in bytes)) return { unknown: `panel state.json unreadable: ${bytes.unknown}` };
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.value.toString('utf8'));
  } catch {
    return { unknown: 'panel state.json is not JSON' };
  }
  const settings = isObj(doc) && isObj(doc.settings) ? doc.settings : {};
  const integrations = isObj(settings.integrations) ? settings.integrations : {};
  const raw = integrations.jira;
  if (!isObj(raw)) return { unknown: 'jira is not configured in the panel' };
  return {
    value: {
      enabled: raw.enabled === true,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      email: typeof raw.email === 'string' ? raw.email : '',
      deployment: typeof raw.deployment === 'string' ? raw.deployment : '',
    },
  };
}

/** Значение доступа интеграции; непрочитанное хранилище — причина с кодом, не «ключа нет». */
function credentialOf(
  appData: string,
  kind: 'jira' | 'gitlab',
): { token: string | null; credential: TrackerCredential; problem?: string } {
  try {
    const token = readKeyStrict(appData, integrationKeyId(kind)) ?? null;
    if (token) return { token, credential: 'stored' };
    return {
      token: null,
      credential: 'missing',
      problem: `no ${kind} credential stored in the panel (missing)`,
    };
  } catch (error) {
    const code = isKeysError(error) ? error.code : 'unreadable';
    return {
      token: null,
      credential: 'unreadable',
      problem: `${kind} key store unreadable (${code})`,
    };
  }
}

/**
 * Jira панели для ядра. Не включена или без адреса — `unknown` (источник не читается, записи не
 * тронуты); ключа нет — порт есть, но каждое чтение называет `missing`.
 */
export function jiraOfPanel(
  appData: string | null | undefined,
  deps: PanelTrackerDeps = {},
): PanelPort<CoreTracker> {
  const got = readPanelJira(appData);
  if ('unknown' in got) return got;
  const jira = got.value;
  const baseUrl = trimUrl(jira.baseUrl);
  if (!jira.enabled) return { unknown: 'jira integration is off in the panel' };
  if (!baseUrl) return { unknown: 'jira integration has no site address in the panel' };
  // Пусто — как панель (`toAccess`): с почтой облако, без почты своя установка.
  const guessed = jira.email.trim() ? 'cloud' : 'server';
  const deployment =
    jira.deployment === 'cloud' || jira.deployment === 'server' ? jira.deployment : guessed;
  const cred = credentialOf(appData!, 'jira');
  const port = createJiraTracker({
    site: { baseUrl, deployment },
    email: jira.email.trim(),
    token: cred.token,
    ...(cred.problem ? { tokenProblem: cred.problem } : {}),
    fetch: deps.fetch ?? createCaFetch(deps.caCertPath ?? ''),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  return { port, credential: cred.credential };
}

export interface CommentBackDeps extends PanelTrackerDeps {
  coreHome: string;
  panelAppData?: string | null;
  /** Причина пропуска не журналится; придержанная и неудачная запись — заметка ядра. */
  note?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Порт комментария назад для попытки публикации (Z7, P166): всё решается на КАЖДОМ открытии MR по
 * действующей настройке ядра — `inbox.commentBack` (по умолчанию выключено), пункт 9
 * `humanPoints.trackerWrites` (пол — `ask`), запись доски задачи (источник трекера, тикет).
 * Задача не с доски, не из трекера, источник не Jira, Jira панели не собрана — `skip` с причиной.
 * Пункт 9 (W2-D): вопрос `tracker-write` и его ответ — книга вопросов задачи; отпускает запись
 * `publish-wiring/comment-release.ts`.
 */
export function commentBackOf(
  deps: CommentBackDeps,
): (task: LiveTask, outbox: OutboxPort) => TrackerCommentPort {
  const layout = layoutOf(deps.coreHome);
  return (task, outbox) => {
    const config = (): ConfigView | null => {
      const got = readCoreConfig(layout);
      return 'value' in got && !got.value.drift ? got.value : null;
    };
    return {
      outbox,
      async target() {
        const view = config();
        if (!view) return { skip: 'core config unread or drifted: no comment back' };
        const inbox = { ...INBOX_DEFAULTS, ...view.doc.inbox };
        if (inbox.commentBack !== true) return { skip: 'comment back is off (inbox.commentBack)' };
        const born = task.state.created?.boardEntry;
        if (!born) return { skip: 'task did not start from the board' };
        if (born.source !== 'tracker')
          return { skip: `task source is ${born.source}, not tracker` };
        const entry = readBoardFile(boardFilePath(layout.root)).entries.find(
          (e) => e.entryId === born.entryId,
        );
        if (!entry) return { skip: `board entry ${born.entryId} not found` };
        const { system, key } = entry.source;
        if (!system || !key) return { skip: 'board entry has no ticket key' };
        const source = inbox.sources.find((s) => s.id === system);
        if (source?.system !== 'jira') return { skip: `inbox source ${system} is not jira` };
        const jira = jiraOfPanel(deps.panelAppData, deps);
        if ('unknown' in jira) return { skip: jira.unknown };
        return { target: { system, key, post: (body) => jira.port.comment(key, body) } };
      },
      wrote: (key) =>
        Object.values(task.state.actions).some(
          (a) => a.kind === 'tracker-write' && a.target === key,
        ),
      trackerWrites: () => config()?.doc.humanPoints?.trackerWrites ?? 'ask',
      approval: (key, unitId) => trackerWriteApproval(readHumanLedger(task), key, unitId),
      askApproval(target, mr) {
        const got = raiseTrackerWriteAsk(task, target, mr);
        if (got.kind !== 'asked' && got.kind !== 'duplicate')
          deps.note?.('inbox.comment-back', {
            taskId: task.taskId,
            message: `point 9 ask for ${target.key} not raised: ${got.reason}`,
          });
      },
      note: (message) => deps.note?.('inbox.comment-back', { taskId: task.taskId, message }),
    };
  };
}

/** Входящие GitLab по сайту панели (D16); не включён — `unknown`. */
export function forgeInboxOfPanel(
  appData: string | null | undefined,
  deps: PanelTrackerDeps = {},
): PanelPort<ForgeInbox> {
  if (!appData) return { unknown: 'no panel data directory: forge settings unread' };
  const { sites, problems } = readPanelForge(appData);
  if (problems.length > 0) return { unknown: problems.join('; ') };
  const site = sites.gitlab;
  if (!site?.enabled) return { unknown: 'gitlab integration is off in the panel' };
  const cred = credentialOf(appData, 'gitlab');
  const port = createForgeInbox({
    kind: 'gitlab',
    baseUrl: siteBaseUrl('gitlab', site.baseUrl),
    token: cred.token,
    ...(cred.problem ? { tokenProblem: cred.problem } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.caCertPath ? { caCertPath: deps.caCertPath } : {}),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  return { port, credential: cred.credential };
}
