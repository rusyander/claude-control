import { z } from 'zod';
import type {
  Analytics,
  CommandResult,
  HistoryDiff,
  HistoryResponse,
  Overview,
  Plugin,
  PluginsState,
  ProviderCompareResponse,
  SearchResponse,
} from '@agentdeck/contracts';
import type { BackupEntry } from '../../domains/backups.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, readRoute, stateCard } from './action-kit.ts';
import { dataField } from './texts.ts';

/**
 * Действия волны A по разделам без собственной записи в конфиг агента:
 * справка, обзор, поиск, аналитика, сравнение CLI, плагины, история и копии.
 * Плагины исполняет CLI за маршрутом: он отвечает 200 и `ok: false` на отказ,
 * и `refusal` превращает такой ответ в честный `failed`.
 */

const language = z
  .enum(['ru', 'en'])
  .optional()
  .describe('Help language; default = panel language');

// --- Справка ---

const searchHelp = definePanelAction({
  name: 'search_help',
  section: 'help',
  risk: 'read',
  description:
    'Search the in-panel help (the same documents the human reads). Returns topics with matching ' +
    'lines (key + text). Use it to answer «how do I…» questions, then read_help_topic for detail.',
  input: z.object({
    query: z.string().trim().min(1).max(300),
    language,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  route: (input) => ({
    method: 'GET',
    url:
      `/api/agent/help/search?q=${encode(input.query)}` +
      (input.language ? `&lang=${input.language}` : '') +
      (input.offset !== undefined ? `&offset=${input.offset}` : '') +
      (input.limit !== undefined ? `&limit=${input.limit}` : ''),
  }),
  summary: 'journal-search-help',
});

const readHelpTopic = definePanelAction({
  name: 'read_help_topic',
  section: 'help',
  risk: 'read',
  description:
    'Read one help topic by id (from search_help or list_help_topics), in pages of lines. ' +
    'Follow nextOffset for the rest.',
  input: z.object({
    id: z.string().trim().min(1).max(60),
    language,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  route: (input) => ({
    method: 'GET',
    url:
      `/api/agent/help/topic?id=${encode(input.id)}` +
      (input.language ? `&lang=${input.language}` : '') +
      (input.offset !== undefined ? `&offset=${input.offset}` : '') +
      (input.limit !== undefined ? `&limit=${input.limit}` : ''),
  }),
  summary: 'journal-read-help-topic',
});

const listHelpTopics = definePanelAction({
  name: 'list_help_topics',
  section: 'help',
  risk: 'read',
  description: 'List help topics in panel order: id, group, section page, title, summary.',
  input: z.object({ language }),
  route: (input) => ({
    method: 'GET',
    url: `/api/agent/help/topics${input.language ? `?lang=${input.language}` : ''}`,
  }),
  summary: 'journal-list-help-topics',
});

// --- Обзор, поиск, аналитика, сравнение ---

const overview = definePanelAction({
  name: 'overview',
  section: 'overview',
  risk: 'read',
  description:
    'Configuration summary: counts of rules, hooks, skills, scripts, MCP, permissions, groups.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/overview' }),
  shape: (_input, body) => body as Overview,
  summary: 'journal-overview',
});

const searchPanel = definePanelAction({
  name: 'search_panel',
  section: 'search',
  risk: 'read',
  description:
    'Search the configuration (rules, skills, hooks, MCP, env keys — never secret values, …). ' +
    'projectPath adds that project’s test cases.',
  input: z.object({
    query: z.string().trim().min(2).max(200),
    projectPath: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  route: (input) => ({
    method: 'GET',
    url:
      `/api/search?q=${encode(input.query)}` +
      (input.projectPath ? `&path=${encode(input.projectPath)}` : ''),
  }),
  shape: (input, body) => {
    const { results } = body as SearchResponse;
    return { total: results.length, results: results.slice(0, input.limit) };
  },
  summary: 'journal-search-panel',
});

const analyticsSummary = definePanelAction({
  name: 'analytics_summary',
  section: 'analytics',
  risk: 'read',
  description:
    'Usage from transcripts for a period: token totals, notional API cost estimate (the account is ' +
    'a subscription — never present it as money charged), top models, projects, tools.',
  input: z.object({
    days: z
      .union([z.literal('today'), z.number().int().min(0).max(365)])
      .default(7)
      .describe('"today", N days, 0 = all time'),
  }),
  route: (input) => ({ method: 'GET', url: `/api/analytics?days=${input.days}` }),
  shape: (_input, body) => {
    const data = body as Analytics;
    return {
      from: data.from,
      to: data.to,
      overall: data.overall,
      estimatedCostNotional: data.estimatedCost,
      cacheHitRatio: data.cacheHitRatio,
      activeSessions: data.activeSessions,
      byModel: data.byModel.slice(0, 10),
      byProject: data.byProject.slice(0, 10),
      topTools: data.topTools.slice(0, 10),
      topSkills: data.topSkills.slice(0, 10),
    };
  },
  summary: 'journal-analytics-summary',
});

const compareProviders = definePanelAction({
  name: 'compare_providers',
  section: 'compare',
  risk: 'read',
  description:
    'Compare two CLI providers side by side (sections, entries present on each side). Read-only.',
  input: z.object({ left: z.string().min(1), right: z.string().min(1) }),
  route: (input) => ({
    method: 'GET',
    url: `/api/provider-compare?left=${encode(input.left)}&right=${encode(input.right)}`,
  }),
  shape: (_input, body) => {
    const data = body as ProviderCompareResponse;
    return {
      left: data.left,
      right: data.right,
      sections: data.sections.map((section) => ({
        section: section.section,
        comparable: section.comparable,
        migratable: section.migratable,
        // Откуда прочитано: сторона Claude — из места конфигурации панели, чужой
        // CLI — из своего каталога (дом процесса панели или его переменная).
        files: { left: section.left.filePath ?? null, right: section.right.filePath ?? null },
        entries: section.entries.slice(0, 50),
        ...(section.note ? { note: section.note } : {}),
      })),
    };
  },
  summary: 'journal-compare-providers',
});

// --- Плагины ---

const pluginRefusal = (body: unknown): string | undefined => {
  const result = body as Partial<CommandResult> | undefined;
  return result && result.ok === false ? result.output || 'CLI refused' : undefined;
};

const pluginsOf = (inject: InjectRoute) => readRoute<PluginsState>(inject, '/api/plugins');

async function findPlugin(inject: InjectRoute, id: string): Promise<Plugin> {
  const plugin = (await pluginsOf(inject)).installed.find((item) => item.id === id);
  if (!plugin) throw new Error(`Plugin «${id}» is not installed. Call list_plugins.`);
  return plugin;
}

const pluginView = (plugin: Plugin) => ({
  id: plugin.id,
  version: plugin.version,
  scope: plugin.scope,
  isEnabled: plugin.isEnabled,
});

const listPlugins = definePanelAction({
  name: 'list_plugins',
  section: 'plugins',
  risk: 'read',
  description:
    'Installed CLI plugins (id name@marketplace, version, scope, enabled) and marketplaces.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/plugins' }),
  shape: (_input, body) => {
    const state = body as PluginsState;
    return {
      installed: state.installed.map((plugin) => ({
        ...pluginView(plugin),
        ...(plugin.installPathMissing ? { installPathMissing: true } : {}),
      })),
      marketplaces: state.marketplaces.map((item) => ({ name: item.name, source: item.source })),
      notes: state.notes,
    };
  },
  summary: 'journal-list-plugins',
});

const listAvailablePlugins = definePanelAction({
  name: 'list_available_plugins',
  section: 'plugins',
  risk: 'read',
  description: 'Plugins available in the connected marketplaces (slow: the CLI refreshes them).',
  input: z.object({ query: z.string().max(100).optional() }),
  route: () => ({ method: 'GET', url: '/api/plugins/available' }),
  shape: (input, body) => {
    const needle = input.query?.toLowerCase();
    return (body as Plugin[])
      .filter(
        (plugin) =>
          !needle ||
          plugin.id.toLowerCase().includes(needle) ||
          (plugin.description ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 50)
      .map((plugin) => ({
        id: plugin.id,
        description: plugin.description,
        isInstalled: plugin.isInstalled,
      }));
  },
  summary: 'journal-list-available-plugins',
});

const pluginId = z.string().trim().min(3).max(200).describe('name@marketplace');

const installPlugin = definePanelAction({
  name: 'install_plugin',
  section: 'plugins',
  risk: 'danger',
  title: 'journal-install-plugin',
  description:
    'Install a plugin through the CLI (clones its marketplace repo; it may run code later). Needs confirmation.',
  input: z.object({ id: pluginId }),
  route: (input) => ({ method: 'POST', url: '/api/plugins/install', body: { id: input.id } }),
  refusal: pluginRefusal,
  fingerprint: async (_input, inject) =>
    fingerprintOf((await pluginsOf(inject)).installed.map(pluginView)),
  preview: async (input, inject) => {
    if ((await pluginsOf(inject)).installed.some((item) => item.id === input.id)) {
      throw new Error(`Plugin «${input.id}» is already installed.`);
    }
    return stateCard(
      `plugins/${input.id}`,
      undefined,
      { id: input.id, installed: true },
      card('summary-plugin-install', { id: input.id }),
    );
  },
  page: () => ({ route: '/plugins' }),
});

const uninstallPlugin = definePanelAction({
  name: 'uninstall_plugin',
  section: 'plugins',
  risk: 'danger',
  title: 'journal-uninstall-plugin',
  description: 'Uninstall a plugin through the CLI. Needs confirmation.',
  input: z.object({ id: pluginId }),
  route: (input) => ({ method: 'POST', url: `/api/plugins/${encode(input.id)}/uninstall` }),
  refusal: pluginRefusal,
  fingerprint: async (input, inject) =>
    fingerprintOf(pluginView(await findPlugin(inject, input.id))),
  preview: async (input, inject) => {
    const plugin = await findPlugin(inject, input.id);
    return stateCard(
      `plugins/${plugin.id}`,
      pluginView(plugin),
      {},
      card('summary-plugin-uninstall', { id: plugin.id }),
    );
  },
  page: () => ({ route: '/plugins' }),
});

const togglePlugin = definePanelAction({
  name: 'toggle_plugin',
  section: 'plugins',
  risk: 'change',
  title: 'journal-toggle-plugin',
  description: 'Enable or disable an installed plugin through the CLI. Needs confirmation.',
  input: z.object({ id: pluginId, isEnabled: z.boolean() }),
  route: (input) => ({
    method: 'POST',
    url: `/api/plugins/${encode(input.id)}/enabled`,
    body: { isEnabled: input.isEnabled },
  }),
  refusal: pluginRefusal,
  fingerprint: async (input, inject) =>
    fingerprintOf(pluginView(await findPlugin(inject, input.id))),
  preview: async (input, inject) => {
    const plugin = await findPlugin(inject, input.id);
    return stateCard(
      `plugins/${plugin.id}`,
      { isEnabled: plugin.isEnabled },
      { isEnabled: input.isEnabled },
      card(input.isEnabled ? 'summary-plugin-enable' : 'summary-plugin-disable', { id: plugin.id }),
    );
  },
  page: () => ({ route: '/plugins' }),
});

const updatePlugin = definePanelAction({
  name: 'update_plugin',
  section: 'plugins',
  risk: 'change',
  title: 'journal-update-plugin',
  description:
    'Update an installed plugin to the marketplace version through the CLI. Needs confirmation.',
  input: z.object({ id: pluginId }),
  route: (input) => ({ method: 'POST', url: `/api/plugins/${encode(input.id)}/update` }),
  refusal: pluginRefusal,
  fingerprint: async (input, inject) =>
    fingerprintOf(pluginView(await findPlugin(inject, input.id))),
  preview: async (input, inject) => {
    const plugin = await findPlugin(inject, input.id);
    return {
      ...card('summary-plugin-update', { id: plugin.id }),
      fields: [dataField('label-version', plugin.version), dataField('label-scope', plugin.scope)],
    };
  },
  page: () => ({ route: '/plugins' }),
});

const addMarketplace = definePanelAction({
  name: 'add_plugin_marketplace',
  section: 'plugins',
  risk: 'danger',
  title: 'journal-add-marketplace',
  description:
    'Connect a plugin marketplace (GitHub repo, URL or path) through the CLI. Needs confirmation.',
  input: z.object({ source: z.string().trim().min(1).max(300) }),
  route: (input) => ({
    method: 'POST',
    url: '/api/plugins/marketplaces',
    body: { source: input.source },
  }),
  refusal: pluginRefusal,
  fingerprint: async (_input, inject) => fingerprintOf((await pluginsOf(inject)).marketplaces),
  preview: async (input, inject) => {
    const { marketplaces } = await pluginsOf(inject);
    if (marketplaces.some((item) => item.source === input.source)) {
      throw new Error(`Marketplace «${input.source}» is already connected.`);
    }
    return stateCard(
      'plugins/known_marketplaces',
      marketplaces.map((item) => item.source),
      [...marketplaces.map((item) => item.source), input.source],
      card('summary-marketplace-add', { source: input.source }),
    );
  },
  page: () => ({ route: '/plugins' }),
});

const removeMarketplace = definePanelAction({
  name: 'remove_plugin_marketplace',
  section: 'plugins',
  risk: 'danger',
  title: 'journal-remove-marketplace',
  description: 'Disconnect a plugin marketplace by name through the CLI. Needs confirmation.',
  input: z.object({ name: z.string().trim().min(1).max(200) }),
  route: (input) => ({ method: 'DELETE', url: `/api/plugins/marketplaces/${encode(input.name)}` }),
  refusal: pluginRefusal,
  fingerprint: async (_input, inject) => fingerprintOf((await pluginsOf(inject)).marketplaces),
  preview: async (input, inject) => {
    const { marketplaces } = await pluginsOf(inject);
    if (!marketplaces.some((item) => item.name === input.name)) {
      throw new Error(`Marketplace «${input.name}» is not connected. Call list_plugins.`);
    }
    return stateCard(
      'plugins/known_marketplaces',
      marketplaces.map((item) => item.name),
      marketplaces.filter((item) => item.name !== input.name).map((item) => item.name),
      card('summary-marketplace-remove', { name: input.name }),
    );
  },
  page: () => ({ route: '/plugins' }),
});

// --- История и резервные копии ---

const listHistory = definePanelAction({
  name: 'list_history',
  section: 'history',
  risk: 'read',
  description:
    'Feed of config edits, newest first: backup name (id for history_diff), file, +/- lines, canRevert.',
  input: z.object({ limit: z.number().int().min(1).max(200).default(30) }),
  route: () => ({ method: 'GET', url: '/api/history' }),
  shape: (input, body) => {
    const items = (body as HistoryResponse).items;
    return { total: items.length, items: items.slice(0, input.limit) };
  },
  summary: 'journal-list-history',
});

const historyDiffOf = (inject: InjectRoute, name: string) =>
  readRoute<HistoryDiff>(inject, `/api/history/diff?name=${encode(name)}`);

const historyDiff = definePanelAction({
  name: 'history_diff',
  section: 'history',
  risk: 'read',
  description:
    'Full line diff of one history entry. Lines carry `hunk` numbers used by revert_history_hunk.',
  input: z.object({ name: z.string().min(1) }),
  route: (input) => ({ method: 'GET', url: `/api/history/diff?name=${encode(input.name)}` }),
  summary: 'journal-history-diff',
});

const revertHistoryHunk = definePanelAction({
  name: 'revert_history_hunk',
  section: 'history',
  risk: 'danger',
  title: 'journal-revert-hunk',
  description:
    'Revert ONE hunk of a history entry into the current config file (a backup of the current state is taken). Needs confirmation.',
  input: z.object({ name: z.string().min(1), hunk: z.number().int().min(0) }),
  route: (input) => ({
    method: 'POST',
    url: '/api/history/revert-hunk',
    body: { name: input.name, hunk: input.hunk },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await historyDiffOf(inject, input.name)),
  preview: async (input, inject) => {
    const diff = await historyDiffOf(inject, input.name);
    if (!diff.canRevert)
      throw new Error(`«${diff.file}» is a provider file: view only, no revert.`);
    const lines = diff.lines.filter((line) => line.hunk === input.hunk);
    if (lines.length === 0)
      throw new Error(`Hunk ${input.hunk} is not in «${input.name}». Call history_diff.`);
    // Откат ханка возвращает строки копии: добавленное правкой уходит, удалённое возвращается.
    const body = lines.map((line) => `${line.kind === 'add' ? '-' : '+'}${line.text}`).join('\n');
    return {
      ...card('summary-revert-hunk', { file: diff.file, hunk: input.hunk }),
      fields: [dataField('label-file', diff.file), dataField('label-backup', input.name)],
      diff: `--- a/${diff.file}\n+++ b/${diff.file}\n@@ hunk ${input.hunk} @@\n${body}\n`,
    };
  },
  page: () => ({ route: '/history' }),
});

interface BackupsInfo {
  items: BackupEntry[];
  isEnabled: boolean;
  encryptSecrets: boolean;
  passphraseLoaded: boolean;
}

const listBackups = definePanelAction({
  name: 'list_backups',
  section: 'history',
  risk: 'read',
  description:
    'Backup copies of config files: name, target file, time, size, restorable, encrypted.',
  input: z.object({ limit: z.number().int().min(1).max(200).default(30) }),
  route: () => ({ method: 'GET', url: '/api/backups' }),
  shape: (input, body) => {
    const info = body as BackupsInfo;
    return {
      isEnabled: info.isEnabled,
      total: info.items.length,
      items: info.items.slice(0, input.limit),
    };
  },
  summary: 'journal-list-backups',
});

async function findBackup(inject: InjectRoute, name: string): Promise<BackupEntry> {
  const entry = (await readRoute<BackupsInfo>(inject, '/api/backups')).items.find(
    (item) => item.name === name,
  );
  if (!entry) throw new Error(`Backup «${name}» not found. Call list_backups.`);
  return entry;
}

const restoreBackup = definePanelAction({
  name: 'restore_backup',
  section: 'history',
  risk: 'danger',
  title: 'journal-restore-backup',
  description:
    'Restore a whole config file (or skill folder) from a backup; the current state is backed up first. ' +
    'Encrypted backups need the passphrase — only the human restores them on the History page. Needs confirmation.',
  input: z.object({ name: z.string().min(1) }),
  route: (input) => ({
    method: 'POST',
    url: `/api/backups/${encode(input.name)}/restore`,
    body: {},
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf({
      entry: await findBackup(inject, input.name),
      feed: (await readRoute<HistoryResponse>(inject, '/api/history')).items.map(
        (item) => item.name,
      ),
    }),
  preview: async (input, inject) => {
    const entry = await findBackup(inject, input.name);
    if (!entry.canRestore) throw new Error(`Backup «${entry.name}» has no place to restore to.`);
    if (entry.encrypted) {
      throw new Error(
        'Encrypted backup: the passphrase is entered only by the human on the History page.',
      );
    }
    return {
      ...card('summary-restore-backup', { target: entry.target }),
      fields: [
        dataField('label-backup', entry.name),
        dataField('label-file', entry.target),
        dataField('label-created', entry.createdAt),
      ],
    };
  },
  shape: (_input, body) => {
    const { ok, restoredTo, backupPath } = body as {
      ok: boolean;
      restoredTo?: string;
      backupPath?: string;
    };
    return { ok, restoredTo, backupPath };
  },
  page: () => ({ route: '/history' }),
});

export const PANEL_READ_ACTIONS: readonly AnyPanelAction[] = [
  searchHelp,
  readHelpTopic,
  listHelpTopics,
  overview,
  searchPanel,
  analyticsSummary,
  compareProviders,
  listPlugins,
  listAvailablePlugins,
  installPlugin,
  uninstallPlugin,
  togglePlugin,
  updatePlugin,
  addMarketplace,
  removeMarketplace,
  listHistory,
  historyDiff,
  revertHistoryHunk,
  listBackups,
  restoreBackup,
];
