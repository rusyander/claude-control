import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { EnvSubscription, SubscriptionsAnswer } from '@agentdeck/contracts/portable-subscribe';
import type {
  TransferApplyAnswer,
  TransferFilePlan,
  TransferPlan,
  TransferRevertAnswer,
  TransferStateAnswer,
} from '@agentdeck/contracts/portable-transfer';
import type { PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, readRoute, routeError } from '../action-kit/action-kit.ts';
import { maskResult } from '../result-net/result-net.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Перенос среды Claude Code в другой CLI и архив среды — маршрутами раздела
 * «Перенос» (`routes/portability-routes/portability-routes.ts`, `routes/env-transfer-routes/env-transfer-routes.ts`).
 *
 * Источник — всегда Claude: панель проверена на нём одном, и перенос «из
 * чужого CLI в чужой» агенту не открыт. Применение строит план тем же
 * маршрутом, что экран, и отдаёт его отпечаток маршруту применения: тот
 * пересчитывает план и откажет 409, если файлы цели сменились. Отмена не
 * трогает файлы, которые человек правил после переноса (`confirm` не шлётся
 * никогда: перезаписать его правку решает только он).
 */

const SOURCE = 'claude';
const ENV_PREVIEW_URL = `/api/env-transfer/preview?provider=${SOURCE}`;
const PLAN_LINES_PER_FILE = 200;

const levelInput = {
  target: z.string().trim().min(1).describe('Target CLI id (codex, gemini, qwen, …)'),
  scope: z.enum(['global', 'project']).default('global'),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Panel project id; needed for scope=project'),
};
const levelSchema = z.object(levelInput);
type Level = z.infer<typeof levelSchema>;

const levelBody = (input: Level) => ({
  provider: SOURCE,
  target: input.target,
  scope: input.scope,
  ...(input.project ? { project: input.project } : {}),
});

const levelQuery = (input: Level) => new URLSearchParams(levelBody(input)).toString();

async function planOf(inject: InjectRoute, input: Level): Promise<TransferPlan> {
  const url = '/api/portability/plan';
  const answer = await inject({ method: 'POST', url, body: levelBody(input) });
  if (answer.status >= 400) throw routeError(url, answer.status, answer.body);
  return answer.body as TransferPlan;
}

const changedFiles = (plan: TransferPlan) => plan.files.filter((file) => !file.unchanged);

/** Сколько записей плана чем кончится: записано, уже есть, не переносится… */
function outcomes(plan: TransferPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of plan.entries) counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  return counts;
}

const fileRow = (file: TransferFilePlan) => ({
  file: file.filePath,
  exists: file.exists,
  unchanged: file.unchanged,
  added: file.added,
  removed: file.removed,
  kinds: file.kinds,
});

/** Дифф файла для карточки: строки маскированы, длинный — обрезан и назван. */
function fileDiff(file: TransferFilePlan): { text: string; cut: boolean } {
  const head = `--- a/${file.filePath}\n+++ b/${file.filePath}\n`;
  if (file.truncated) return { text: `${head}(too large for a line diff)`, cut: true };
  const mark = { add: '+', del: '-', ctx: ' ' } as const;
  const lines = file.lines.slice(0, PLAN_LINES_PER_FILE);
  const body = lines.map((line) => `${mark[line.kind]}${maskSecretsInText(line.text)}`).join('\n');
  const cut = file.lines.length > lines.length;
  return { text: `${head}${body}${cut ? '\n…' : ''}`, cut };
}

const portabilityPlan = definePanelAction({
  name: 'portability_plan',
  section: 'portability',
  risk: 'read',
  description:
    'Plan of carrying the Claude Code environment into another CLI: which files of the target ' +
    'would change (+/- lines), and how many items get written, already exist, or cannot be carried. ' +
    'Writes nothing; apply_portability does.',
  input: levelSchema,
  // Сначала след прошлого переноса (чтение), затем сам план: маршрут плана —
  // предпросмотр (`internal:preview` в реестре возможностей), его зовут и
  // карточка применения, и этот второй шаг.
  route: (input) => ({ method: 'GET', url: `/api/portability/transfer?${levelQuery(input)}` }),
  afterRoute: async (input, body, inject) => ({
    plan: await planOf(inject, input),
    last: body as TransferStateAnswer,
  }),
  shape: (_input, body) => {
    const { plan, last } = body as { plan: TransferPlan; last: TransferStateAnswer };
    return {
      ...(last.record ? { lastCarriedAt: last.record.appliedAt } : {}),
      source: plan.source,
      target: plan.target,
      scope: plan.scope,
      root: plan.root,
      outcomes: outcomes(plan),
      files: plan.files.map(fileRow),
      notCarried: plan.entries
        .filter((entry) => entry.outcome !== 'written' && entry.outcome !== 'already_available')
        .slice(0, 40)
        .map((entry) => ({ kind: entry.kind, intent: entry.intent, outcome: entry.outcome })),
    };
  },
  summary: 'journal-portability-plan',
});

const applyPortability = definePanelAction({
  name: 'apply_portability',
  section: 'portability',
  risk: 'danger',
  title: 'journal-apply-portability',
  description:
    'Carry the Claude Code environment into another CLI: writes the target files shown by ' +
    'portability_plan. Backups are made first; revert_portability undoes it. Needs the human’s ' +
    'confirmation on the full per-file diff.',
  input: levelSchema,
  // План пересчитывается прямо перед записью: маршрут применения принимает
  // только отпечаток показанного плана и сам сверяет его со свежим.
  route: async (input, inject) => {
    const plan = await planOf(inject, input);
    return {
      method: 'POST',
      url: '/api/portability/apply',
      body: { ...levelBody(input), fingerprint: plan.fingerprint },
    };
  },
  fingerprint: async (input, inject) => fingerprintOf((await planOf(inject, input)).fingerprint),
  preview: async (input, inject): Promise<PanelActionPreview> => {
    const plan = await planOf(inject, input);
    const changed = changedFiles(plan);
    if (!changed.length) {
      throw new Error('Nothing would change: the target already has this environment.');
    }
    const diffs = changed.map(fileDiff);
    return {
      ...(diffs.some((diff) => diff.cut) ? { truncated: true } : {}),
      ...card('summary-apply-portability', { source: plan.source, target: plan.target }),
      fields: [
        dataField('label-target-root', plan.root),
        ...changed.map((file) =>
          dataField(
            file.exists ? 'label-file' : 'label-new-file',
            `${file.filePath} (+${file.added} −${file.removed})`,
          ),
        ),
        textField('label-what-happens', 'value-portability-backup'),
      ],
      diff: diffs.map((diff) => diff.text).join('\n'),
    };
  },
  shape: (_input, body) => {
    const answer = body as TransferApplyAnswer;
    return {
      applied: true,
      target: answer.record.target,
      scope: answer.record.scope,
      files: answer.record.files.map((file) => ({
        file: file.filePath,
        backedUp: file.backupPath !== null,
      })),
    };
  },
  page: () => ({ route: '/portability' }),
});

const readTransfer = (inject: InjectRoute, input: Level) =>
  readRoute<TransferStateAnswer>(inject, `/api/portability/transfer?${levelQuery(input)}`);

const revertPortability = definePanelAction({
  name: 'revert_portability',
  section: 'portability',
  risk: 'danger',
  title: 'journal-revert-portability',
  description:
    'Undo the last carry into this target: target files return to their backups. Files the human ' +
    'edited after the carry are kept as they are and named. Needs the human’s confirmation.',
  input: levelSchema,
  route: (input) => ({ method: 'POST', url: '/api/portability/revert', body: levelBody(input) }),
  fingerprint: async (input, inject) => fingerprintOf(await readTransfer(inject, input)),
  preview: async (input, inject) => {
    const state = await readTransfer(inject, input);
    if (!state.record) {
      throw new Error('Nothing to undo: the panel has not carried the environment to this target.');
    }
    return {
      ...card('summary-revert-portability', {
        source: state.record.source,
        target: state.record.target,
      }),
      fields: [
        dataField('label-file', state.record.files.map((file) => file.filePath).join('\n')),
        state.changedSince.length
          ? dataField('label-changed-since', state.changedSince.join('\n'))
          : textField('label-changed-since', 'value-changed-since-none'),
      ],
    };
  },
  shape: (_input, body) => {
    const answer = body as TransferRevertAnswer;
    return {
      restored: answer.restored,
      keptEditedByHuman: answer.changedSince,
      stillRecorded: answer.record !== null,
    };
  },
  page: () => ({ route: '/portability' }),
});

const portabilityTransfer = definePanelAction({
  name: 'portability_transfer',
  section: 'portability',
  risk: 'read',
  description:
    'The last carry of the Claude Code environment into this target: when, which files, and which ' +
    'of them the human changed afterwards. null = the panel never carried there.',
  input: levelSchema,
  route: (input) => ({ method: 'GET', url: `/api/portability/transfer?${levelQuery(input)}` }),
  shape: (_input, body) => {
    const state = body as TransferStateAnswer;
    return state.record
      ? {
          appliedAt: state.record.appliedAt,
          files: state.record.files.map((file) => file.filePath),
          changedSince: state.changedSince,
        }
      : { record: null };
  },
  summary: 'journal-portability-transfer',
});

const listSubscriptions = definePanelAction({
  name: 'list_portability_subscriptions',
  section: 'portability',
  risk: 'read',
  description:
    'Environment subscriptions: which CLIs follow the panel’s environment and by which layers. ' +
    'Subscribing and unsubscribing stay with the human.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/portability/subscriptions' }),
  shape: (_input, body) => ({
    items: (body as SubscriptionsAnswer).items.map((item: EnvSubscription) => maskResult(item)),
  }),
  summary: 'journal-portability-subscriptions',
});

interface EnvPreview {
  provider: { id: string; name: string };
  platforms: { id: string; title: string }[];
  files: number;
  bytes: number;
  skipped: unknown[];
  checklist: unknown[];
}

const envTransferPreview = definePanelAction({
  name: 'env_transfer_preview',
  section: 'portability',
  risk: 'read',
  description:
    'What an environment archive of Claude Code would hold (for moving to another machine): file ' +
    'count, size, skipped files, contours carried, and the checklist of what is re-entered there ' +
    '(secrets never travel).',
  input: z.object({}),
  route: () => ({ method: 'GET', url: ENV_PREVIEW_URL }),
  shape: (_input, body) => {
    const preview = body as EnvPreview;
    return maskResult({
      files: preview.files,
      bytes: preview.bytes,
      contours: preview.platforms.map((platform) => platform.title),
      skipped: preview.skipped,
      checklist: preview.checklist,
    });
  },
  summary: 'journal-env-transfer-preview',
});

const envTransferExport = definePanelAction({
  name: 'env_transfer_export',
  section: 'portability',
  risk: 'change',
  title: 'journal-env-transfer-export',
  description:
    'Build the Claude Code environment archive (.zip) into an existing folder. Secret values are ' +
    'replaced by placeholders. Needs the human’s confirmation.',
  input: z.object({
    targetDir: z.string().trim().min(1).describe('Absolute path of an existing folder'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/env-transfer/export',
    body: { provider: SOURCE, targetDir: input.targetDir },
  }),
  fingerprint: async (_input, inject) => {
    const preview = await readRoute<EnvPreview>(inject, ENV_PREVIEW_URL);
    return fingerprintOf({ files: preview.files, bytes: preview.bytes });
  },
  preview: async (input, inject) => {
    // Папку проверяем до карточки: одобрение записи в несуществующее место
    // кончилось бы отказом маршрута уже после «да» человека.
    if (!isAbsolute(input.targetDir) || !existsSync(input.targetDir)) {
      throw new Error(`"${input.targetDir}" is not an existing absolute folder.`);
    }
    const preview = await readRoute<EnvPreview>(inject, ENV_PREVIEW_URL);
    return {
      ...card('summary-env-transfer-export'),
      fields: [
        dataField('label-directory', input.targetDir),
        dataField('label-archive-content', `${preview.files} / ${preview.bytes} B`),
        textField('label-what-happens', 'value-archive-no-secrets'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as { path: string; bytes: number; files: number; platforms: number };
    return {
      path: result.path,
      bytes: result.bytes,
      files: result.files,
      contours: result.platforms,
    };
  },
});

/** Перенос среды и архив: в порядке показа. */
export const PORTABILITY_ACTIONS: readonly AnyPanelAction[] = [
  portabilityPlan,
  applyPortability,
  revertPortability,
  portabilityTransfer,
  listSubscriptions,
  envTransferPreview,
  envTransferExport,
];
