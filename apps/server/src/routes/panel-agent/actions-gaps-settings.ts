import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AnalyticsPricing,
  ProviderCheckResult,
  ProviderChecksResponse,
  ProvidersResponse,
} from '@agentdeck/contracts';
import type { ResourceSummary } from '@agentdeck/contracts/group-path';
import type { FidelityAnswer } from '@agentdeck/contracts/portable-fidelity';
import { encode, readRoute } from './action-kit.ts';
import { findProject } from './actions-projects.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { maskResult } from './result-net.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Настройки, провайдер, интеграции, перенос и группы — то, чего агенту не
 * хватало (дорожка A, 28.09): прайс моделей, редакторы, доступ Claude Code к
 * аккаунту, обзор папок для выбора проекта, провайдеры и их проверка, переходы
 * задачи Jira, верность переноса среды и краткое описание ресурса.
 *
 * Ничего из этого не читает и не пишет секрет: маршрут доступа отдаёт только
 * источник, маршрут прайса вызывается без `refresh` (сеть трогает только
 * кнопка человека), обзор папок — только каталоги, как окно выбора папки.
 */

// ── settings ──────────────────────────────────────────────────────────────

const readModelPricing = definePanelAction({
  name: 'read_model_pricing',
  section: 'settings',
  risk: 'read',
  description:
    'Model prices the panel uses for its notional cost estimates: per model input / output / ' +
    'cache rates per million tokens, where the price list came from and how fresh it is, and the ' +
    'human’s own prices. The subscription is not billed by these numbers.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/analytics/pricing' }),
  shape: (_input, body) => {
    const pricing = body as AnalyticsPricing;
    return {
      source: pricing.source,
      fetchedAt: pricing.fetchedAt,
      stale: pricing.stale,
      entries: pricing.entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        price: entry.price,
        ...(entry.from ? { from: entry.from } : {}),
        ...(entry.until ? { until: entry.until } : {}),
      })),
      custom: pricing.custom,
    };
  },
  summary: 'journal-read-model-pricing',
});

const listEditors = definePanelAction({
  name: 'list_editors',
  section: 'settings',
  risk: 'read',
  description:
    'Code editors the panel knows and whether each is installed on this machine (the choice ' +
    'of «Открыть в редакторе» in settings).',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/editors' }),
  shape: (_input, body) => ({
    editors: (body as Array<{ id: string; name: string; available: boolean }>).map((editor) => ({
      id: editor.id,
      name: editor.name,
      installed: editor.available,
    })),
  }),
  summary: 'journal-list-editors',
});

const readClaudeAccess = definePanelAction({
  name: 'read_claude_access',
  section: 'settings',
  risk: 'read',
  description:
    'Where Claude Code’s account access comes from on this machine (its own login, the ' +
    'system keychain, a token the human saved in the panel) or why there is none. The token ' +
    'itself is never returned; entering or removing it is the human’s.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/credentials' }),
  shape: (_input, body) => {
    const access = body as {
      source: string;
      reason?: string;
      hasManual: boolean;
      platform: string;
    };
    return maskResult({
      source: access.source,
      ...(access.reason ? { reason: access.reason } : {}),
      savedInPanel: access.hasManual,
      platform: access.platform,
    });
  },
  summary: 'journal-read-claude-access',
});

// ── projects: обзор папок ─────────────────────────────────────────────────

const FOLDER_LIMIT = 200;

const browseFolders = definePanelAction({
  name: 'browse_folders',
  section: 'projects',
  risk: 'read',
  description:
    'Browse folders of this machine the way the project folder picker does: without path — the ' +
    'roots (home and drives); with an absolute path — its subfolders (hidden ones and files are ' +
    'not listed) and the parent. Use it to find the folder a human means before create_project.',
  input: z.object({
    path: z.string().trim().min(1).optional().describe('Absolute folder path; omit = the roots'),
  }),
  route: (input) =>
    input.path
      ? { method: 'GET', url: `/api/fs/list?path=${encode(input.path)}` }
      : { method: 'GET', url: '/api/fs/roots' },
  shape: (_input, body) => {
    const names = (entries: Array<{ name: string; path: string; isFile?: boolean }>) => {
      const folders = entries.filter((entry) => !entry.isFile);
      return {
        folders: folders
          .slice(0, FOLDER_LIMIT)
          .map((entry) => ({ name: entry.name, path: entry.path })),
        ...(folders.length > FOLDER_LIMIT ? { total: folders.length } : {}),
      };
    };
    if (Array.isArray(body)) return maskResult({ roots: true, ...names(body) });
    const listing = body as {
      path: string;
      parent?: string;
      entries: Array<{ name: string; path: string; isFile?: boolean }>;
    };
    return maskResult({
      path: listing.path,
      ...(listing.parent ? { parent: listing.parent } : {}),
      ...names(listing.entries),
    });
  },
  summary: 'journal-browse-folders',
});

// ── provider ──────────────────────────────────────────────────────────────

const listProviders = definePanelAction({
  name: 'list_providers',
  section: 'provider',
  risk: 'read',
  description:
    'CLIs the panel can configure, which one is active, and which are verified (Claude) or ' +
    'experimental. Switching the provider is the human’s choice in settings.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/providers' }),
  shape: (_input, body) => {
    const answer = body as ProvidersResponse;
    return {
      active: answer.active,
      providers: answer.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        status: provider.status,
      })),
    };
  },
  summary: 'journal-list-providers',
});

const checkRow = (check: ProviderCheckResult) =>
  maskResult({
    provider: check.provider,
    name: check.providerName,
    at: check.at,
    level: check.level,
    steps: check.steps.map((step) => ({
      id: step.id,
      status: step.status,
      detail: step.detail,
    })),
  });

const readProviderChecks = definePanelAction({
  name: 'read_provider_checks',
  section: 'provider',
  risk: 'read',
  description:
    'Saved results of the provider checks on this machine (the badges in settings): per ' +
    'provider the level (verified / partial / failed), when, and each step. Runs nothing.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/providers/checks' }),
  shape: (_input, body) => ({
    checks: Object.values((body as ProviderChecksResponse).checks).map(checkRow),
  }),
  summary: 'journal-read-provider-checks',
});

/** Имя Claude для карточки — как его пишет список провайдеров. */
async function claudeName(inject: InjectRoute): Promise<string> {
  const answer = await readRoute<ProvidersResponse>(inject, '/api/providers');
  return answer.providers.find((provider) => provider.id === 'claude')?.name ?? 'Claude Code';
}

const runProviderCheck = definePanelAction({
  name: 'run_provider_check',
  section: 'provider',
  risk: 'change',
  title: 'journal-run-provider-check',
  description:
    'Run the Claude provider check on this machine now (settings’ «Проверить»): CLI, config, ' +
    'MCP, permissions, env and instructions, the write round on a temporary copy — the human’s ' +
    'files are not written. withModelCall=true adds one short real model call (spends the ' +
    'subscription). The result is saved as the badge. Claude only. Needs the human’s confirmation.',
  input: z.object({
    withModelCall: z
      .boolean()
      .default(false)
      .describe('Also make one short real model call (spends the subscription)'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/providers/claude/check',
    body: { assistant: input.withModelCall },
  }),
  fingerprint: async (input, inject) => {
    const checks = await readRoute<ProviderChecksResponse>(inject, '/api/providers/checks');
    return fingerprintOf({ model: input.withModelCall, last: checks.checks.claude?.at ?? null });
  },
  preview: async (input, inject) => ({
    ...summaryText('summary-run-provider-check', { name: await claudeName(inject) }),
    fields: [
      textField(
        'label-provider-check-model-call',
        input.withModelCall
          ? 'value-provider-check-model-call-on'
          : 'value-provider-check-model-call-off',
      ),
      textField('label-what-happens', 'value-provider-check-effect'),
    ],
  }),
  shape: (_input, body) => checkRow(body as ProviderCheckResult),
  page: () => ({ route: '/settings', focus: 'providers' }),
});

// ── integrations ──────────────────────────────────────────────────────────

const jiraTransitions = definePanelAction({
  name: 'jira_transitions',
  section: 'integrations',
  risk: 'read',
  description:
    'Workflow transitions available now for one Jira issue (id and name). Read-only: moving ' +
    'the issue is the human’s click in the panel.',
  input: z.object({
    key: z.string().trim().min(1).max(64).describe('Issue key, e.g. PROJ-123'),
  }),
  route: (input) => ({
    method: 'GET',
    url: `/api/integrations/jira/issue/${encode(input.key)}/transitions`,
  }),
  shape: (_input, body) =>
    maskResult({
      transitions: (body as Array<{ id: string; name: string }>).map((item) => ({
        id: item.id,
        name: item.name,
      })),
      note: 'Applying a transition is the human’s: ask them to press it in the panel.',
    }),
  summary: 'journal-jira-transitions',
});

// ── portability ───────────────────────────────────────────────────────────

const ROW_LIMIT = 100;

/**
 * Id записи хука в каноне переноса несёт саму команду (`hook:<событие>-<matcher>-<команда>`),
 * расплющенную в slug: ключ из `--token X` там стоит голым, и маска секретов его не
 * узнаёт — прогон канареек поймал это на `portability_fidelity`. То же у разрешения
 * (`permission:<решение>-<правило>`): «всегда разрешить» пишет команду буквально,
 * с `Bearer …` и `API_TOKEN=…` внутри (ревью сит, 28.09). Модели остаётся событие
 * или решение и короткий хеш: запись различима, команда — нет; само правило она
 * видит в `intent`, который проходит маску целым текстом.
 */
const HASHED_KINDS = ['hook:', 'permission:'] as const;

const itemOf = (itemId: string): string => {
  const kind = HASHED_KINDS.find((prefix) => itemId.startsWith(prefix));
  if (!kind) return itemId;
  const head = itemId.slice(kind.length).split('-')[0] ?? '';
  return `${kind}${head}#${createHash('sha1').update(itemId).digest('hex').slice(0, 8)}`;
};

const portabilityFidelity = definePanelAction({
  name: 'portability_fidelity',
  section: 'portability',
  risk: 'read',
  description:
    'How faithfully the Claude environment would carry over to another CLI: per entry (skill, ' +
    'hook, rule, permission, MCP) the level (native / emulated / wired / text / impossible), the ' +
    'reason and condition, plus totals and how many work only when run through the panel. ' +
    'Hooks and permissions are named by event or decision and a short hash — their command ' +
    'may carry a key; the rule itself is in the masked intent. ' +
    'Computed fresh; writes nothing into any CLI.',
  input: z.object({
    target: z.string().trim().min(1).describe('Target CLI id (codex, gemini, qwen, …)'),
    scope: z.enum(['global', 'project']).default('global'),
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Panel project id; needed for scope=project'),
  }),
  route: (input) => {
    const query = new URLSearchParams({
      provider: 'claude',
      target: input.target,
      scope: input.scope,
      ...(input.project ? { project: input.project } : {}),
    });
    return { method: 'GET', url: `/api/portability/fidelity?${query.toString()}` };
  },
  shape: (_input, body) => {
    const { report, previous } = body as FidelityAnswer;
    return maskResult({
      target: report.target,
      scope: report.scope,
      computedAt: report.computedAt,
      summary: report.summary,
      onlyThroughPanel: report.onlyThroughPanel,
      rows: report.rows.slice(0, ROW_LIMIT).map((row) => ({
        item: itemOf(row.itemId),
        kind: row.kind,
        level: row.level,
        reason: row.reason,
        ...(row.condition ? { condition: row.condition } : {}),
        intent: row.intent,
      })),
      ...(report.rows.length > ROW_LIMIT ? { rowsTotal: report.rows.length } : {}),
      previous,
    });
  },
  summary: 'journal-portability-fidelity',
});

// ── groups: краткое описание ресурса ──────────────────────────────────────

const summaryInput = z.object({
  type: z.enum(['skill', 'hook', 'rule']).describe('Kind of resource'),
  id: z.string().trim().min(1).max(300).describe('Resource id as the lists give it'),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Registered project id or path for a project resource; omit = global'),
});
type SummaryInput = z.infer<typeof summaryInput>;

const projectDirOf = async (inject: InjectRoute, input: SummaryInput) =>
  input.project ? (await findProject(inject, input.project)).path : undefined;

const summarizeResource = definePanelAction({
  name: 'summarize_resource',
  section: 'groups',
  risk: 'change',
  title: 'journal-summarize-resource',
  description:
    'Short description (ru + en) of one skill, hook or rule — the one the groups page shows. ' +
    'Cached per content; on a cache miss the panel makes one cheap model call (spends the ' +
    'subscription) and remembers the answer. Needs the human’s confirmation.',
  input: summaryInput,
  route: async (input, inject) => {
    const path = await projectDirOf(inject, input);
    const query = new URLSearchParams({
      type: input.type,
      id: input.id,
      ...(path ? { path } : {}),
    });
    return { method: 'GET', url: `/api/resources/summary?${query.toString()}` };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({ type: input.type, id: input.id, path: await projectDirOf(inject, input) }),
  preview: async (input, inject) => {
    const path = await projectDirOf(inject, input);
    return {
      ...summaryText('summary-summarize-resource', { name: input.id }),
      fields: [
        dataField('label-resource-kind', input.type),
        ...(path ? [dataField('label-project', path)] : []),
        textField('label-what-happens', 'value-summarize-resource-effect'),
      ],
    };
  },
  shape: (_input, body) => {
    const summary = body as ResourceSummary;
    return maskResult({ ru: summary.ru, en: summary.en });
  },
});

/** Действия настроек, провайдера, интеграций, переноса и групп дорожки A. */
export const GAPS_SETTINGS_ACTIONS: readonly AnyPanelAction[] = [
  readModelPricing,
  listEditors,
  readClaudeAccess,
  browseFolders,
  listProviders,
  readProviderChecks,
  runProviderCheck,
  jiraTransitions,
  portabilityFidelity,
  summarizeResource,
];
