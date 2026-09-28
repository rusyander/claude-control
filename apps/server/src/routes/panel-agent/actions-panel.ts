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
import type { AgentEnvironment, EnvItem } from '@agentdeck/contracts/portable-env';
import type { BackupEntry } from '../../domains/backups.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, listPage, OFFSET_DESCRIPTION, readRoute, stateCard } from './action-kit.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import { safePluginId } from '../../lib/cli-args.ts';
import { isMarketplaceSource } from '../../domains/plugins/actions.ts';
import { dataField } from './texts.ts';
import { assertRegistered } from './registered-folder.ts';

/**
 * Действия волны A по разделам без собственной записи в конфиг агента:
 * справка, обзор, поиск, аналитика, сравнение CLI, плагины, история и копии.
 * Плагины исполняет CLI за маршрутом: он отвечает 200 и `ok: false` на отказ,
 * и `refusal` превращает такой ответ в честный `failed`.
 */

const offset = z.number().int().min(0).default(0).describe(OFFSET_DESCRIPTION);

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
    'lines (key + text). Use it to answer «how do I…» questions, then read_help_topic for detail. ' +
    'Nothing in the panel language → it searches the other one and says so (searchedFirst); ' +
    'topic ids are shared, so read the topic in the human’s language.',
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
    'projectPath adds that project’s test cases. Paged: follow nextOffset.',
  input: z.object({
    query: z.string().trim().min(2).max(200),
    projectPath: z.string().trim().min(1).optional(),
    offset,
    limit: z.number().int().min(1).max(100).default(30),
  }),
  // Кейсы — только проекта панели: чужую папку поиск не читает.
  route: async (input, inject) => {
    if (input.projectPath) await assertRegistered(inject, input.projectPath);
    return {
      method: 'GET',
      url:
        `/api/search?q=${encode(input.query)}` +
        (input.projectPath ? `&path=${encode(input.projectPath)}` : ''),
    };
  },
  shape: (input, body) => {
    const { meta, slice } = listPage((body as SearchResponse).results, input.offset, input.limit);
    return { ...meta, results: slice };
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

/** Записей раздела сравнения на страницу: дальше — по `entriesNextOffset`. */
const COMPARE_ENTRIES_LIMIT = 50;

const compareProviders = definePanelAction({
  name: 'compare_providers',
  section: 'compare',
  risk: 'read',
  description:
    'Compare two CLI providers side by side (sections, entries present on each side). Read-only. ' +
    `Entries are paged by ${COMPARE_ENTRIES_LIMIT} per section: pass section and offset = entriesNextOffset for the rest.`,
  input: z.object({
    left: z.string().min(1),
    right: z.string().min(1),
    section: z.string().min(1).optional().describe('Only this section (e.g. "mcp")'),
    offset: offset.describe('Skip this many entries in each section; pass entriesNextOffset'),
  }),
  route: (input) => ({
    method: 'GET',
    url: `/api/provider-compare?left=${encode(input.left)}&right=${encode(input.right)}`,
  }),
  shape: (input, body) => {
    const data = body as ProviderCompareResponse;
    // Опечатка в разделе давала пустой список — модель читала его как «различий нет».
    if (input.section && !data.sections.some((section) => section.section === input.section)) {
      const known = data.sections.map((section) => section.section).join(', ');
      throw new Error(`No section «${input.section}» in this comparison; known: ${known}.`);
    }
    return {
      left: data.left,
      right: data.right,
      sections: data.sections
        .filter((section) => !input.section || section.section === input.section)
        .map((section) => {
          const { meta, slice } = listPage(section.entries, input.offset, COMPARE_ENTRIES_LIMIT);
          return {
            section: section.section,
            comparable: section.comparable,
            migratable: section.migratable,
            // Откуда прочитано: сторона Claude — из места конфигурации панели, чужой
            // CLI — из своего каталога (дом процесса панели или его переменная).
            files: { left: section.left.filePath ?? null, right: section.right.filePath ?? null },
            entries: slice,
            entriesTotal: meta.total,
            ...(meta.nextOffset === undefined ? {} : { entriesNextOffset: meta.nextOffset }),
            ...(section.note ? { note: section.note } : {}),
          };
        }),
    };
  },
  summary: 'journal-compare-providers',
});

/** Сколько записей паспорта едет модели: дальше растёт только объём ответа. */
const PASSPORT_ITEM_LIMIT = 100;

/**
 * Первые записи паспорта — но ни один вид не теряется целиком.
 *
 * Записи отсортированы по `id`, то есть по виду: простая обрезка выбрасывала
 * хвост алфавита ЦЕЛИКОМ. Сначала берётся по одной записи каждого вида, дальше —
 * остальные по порядку.
 */
function firstOfEachKind(items: readonly EnvItem[], limit: number): EnvItem[] {
  const seen = new Set<string>();
  const first: EnvItem[] = [];
  const rest: EnvItem[] = [];
  for (const item of items) {
    if (seen.has(item.kind)) rest.push(item);
    else {
      seen.add(item.kind);
      first.push(item);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

const readPassport = definePanelAction({
  name: 'read_env_passport',
  section: 'portability',
  risk: 'read',
  description:
    'Environment passport of one CLI: what it actually has configured, by item kind, plus named skips. Secret values are never carried. Read-only.',
  input: z.object({
    provider: z.string().min(1).optional().describe('Provider id; default = active provider'),
  }),
  route: (input) => ({
    method: 'GET',
    url: input.provider
      ? `/api/portability/passport?provider=${encode(input.provider)}`
      : '/api/portability/passport',
  }),
  shape: (_input, body) => {
    const data = body as AgentEnvironment;
    const byKind: Record<string, number> = {};
    for (const item of data.items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

    const shown = firstOfEachKind(data.items, PASSPORT_ITEM_LIMIT);

    return {
      provider: data.provider,
      scope: data.scope,
      root: data.root,
      canonVersion: data.canonVersion,
      byKind,
      // Обрезка НАЗВАНА и пересчитана: список, молча обрезанный по `id`, отдавал
      // модели среду без скиллов, секретов и субагентов целиком — на живом доме
      // в 209 записей хвост алфавита не доезжал вовсе.
      itemsShown: shown.length,
      itemsTotal: data.items.length,
      itemsTruncated: shown.length < data.items.length,
      // Намерение записи — это и есть её смысл человеку; сырое тело сюда не
      // едет: паспорт может быть большим, а модели нужен состав среды.
      items: shown.map((item) => ({
        kind: item.kind,
        intent: item.intent,
        file: item.source.file,
        needs: item.needs.resolution === 'facts' ? item.needs.facts : item.needs.resolution,
      })),
      // Пропуски едут ЦЕЛИКОМ: обрезанный список пропусков читался бы как
      // «остального нет», а это ровно та ложь о среде, против которой паспорт.
      skipped: data.skipped,
    };
  },
  summary: 'journal-env-passport',
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
  description:
    'Plugins available in the connected marketplaces (slow: the CLI refreshes them). Paged: follow nextOffset.',
  input: z.object({
    query: z.string().max(100).optional(),
    offset,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  route: () => ({ method: 'GET', url: '/api/plugins/available' }),
  shape: (input, body) => {
    const needle = input.query?.toLowerCase();
    const found = (body as Plugin[]).filter(
      (plugin) =>
        !needle ||
        plugin.id.toLowerCase().includes(needle) ||
        (plugin.description ?? '').toLowerCase().includes(needle),
    );
    const { meta, slice } = listPage(found, input.offset, input.limit);
    return {
      ...meta,
      plugins: slice.map((plugin) => ({
        id: plugin.id,
        description: plugin.description,
        isInstalled: plugin.isInstalled,
      })),
    };
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
    // Несбыточное отсекается до карточки: кривой id домен отвергнет, а плагин
    // неподключённого маркетплейса CLI не найдёт — оба уже после «Одобрить».
    // Отказ `safePluginId` — русский, для человека; агенту — английский.
    try {
      safePluginId(input.id);
    } catch {
      throw new Error(
        `«${input.id}» is not a valid plugin id: use name@marketplace (letters, digits, . _ @ / -).`,
      );
    }
    const { installed, marketplaces } = await pluginsOf(inject);
    if (installed.some((item) => item.id === input.id)) {
      throw new Error(`Plugin «${input.id}» is already installed.`);
    }
    const at = input.id.lastIndexOf('@');
    const market = at > 0 ? input.id.slice(at + 1) : '';
    // Пустой список — состояние не прочиталось; решать за CLI тогда не берёмся.
    if (market && marketplaces.length > 0 && !marketplaces.some((item) => item.name === market)) {
      const connected = marketplaces.map((item) => item.name).join(', ');
      throw new Error(
        `Marketplace «${market}» is not connected (connected: ${connected}). ` +
          'Call list_available_plugins, or add_plugin_marketplace first.',
      );
    }
    const preview = stateCard(
      `plugins/${input.id}`,
      undefined,
      { id: input.id, installed: true },
      card('summary-plugin-install', { id: input.id }),
    );
    // Опасна установка тем, что потом исполнится чужой код, — карточка называет,
    // из какого репозитория он придёт.
    const source = marketplaces.find((item) => item.name === market)?.source;
    return source ? { ...preview, fields: [dataField('label-address', source)] } : preview;
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
      fields: [
        dataField('label-version', plugin.version),
        dataField('label-plugin-scope', plugin.scope),
      ],
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
    if (!isMarketplaceSource(input.source)) {
      throw new Error(
        `Source «${input.source}» is not a GitHub owner/repo, URL or path ` +
          '(no spaces or shell characters).',
      );
    }
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

/**
 * Время так, как его показывает страница истории: местное время машины (панель
 * локальная — сервер и окно в одном часовом поясе). Модель, прочитав UTC из
 * `at`, называла человеку «20:52», а на странице стояло «23:52».
 */
function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const listHistory = definePanelAction({
  name: 'list_history',
  section: 'history',
  risk: 'read',
  description:
    'Feed of config edits, newest first: backup name (id for history_diff), file, +/- lines, canRevert, ' +
    'label ("current" = the newest copy of that file, diffed against the live file — the only one revert_history_hunk takes). ' +
    'Name times by localTime — the History page shows local time, `at` is UTC. Paged: follow nextOffset.',
  input: z.object({ offset, limit: z.number().int().min(1).max(200).default(30) }),
  route: () => ({ method: 'GET', url: '/api/history' }),
  shape: (input, body) => {
    const { meta, slice } = listPage((body as HistoryResponse).items, input.offset, input.limit);
    return { ...meta, items: slice.map((item) => ({ ...item, localTime: localTime(item.at) })) };
  },
  summary: 'journal-list-history',
});

const historyDiffOf = (inject: InjectRoute, name: string) =>
  readRoute<HistoryDiff>(inject, `/api/history/diff?name=${encode(name)}`);

/**
 * Строки диффа истории для модели и карточки — маской: маршрут окна отдаёт их
 * как есть, а в правке человека бывает ключ. Номера ханков остаются.
 */
const maskedLines = (lines: HistoryDiff['lines']): HistoryDiff['lines'] =>
  lines.map((line) => ({ ...line, text: maskSecretsInText(line.text) }));

const historyDiff = definePanelAction({
  name: 'history_diff',
  section: 'history',
  risk: 'read',
  description:
    'Full line diff of one history entry. Lines carry `hunk` numbers used by revert_history_hunk.',
  input: z.object({ name: z.string().min(1) }),
  route: (input) => ({ method: 'GET', url: `/api/history/diff?name=${encode(input.name)}` }),
  shape: (_input, body) => {
    const diff = body as HistoryDiff;
    return { ...diff, lines: maskedLines(diff.lines) };
  },
  summary: 'journal-history-diff',
});

const revertHistoryHunk = definePanelAction({
  name: 'revert_history_hunk',
  section: 'history',
  risk: 'danger',
  title: 'journal-revert-hunk',
  description:
    'Revert ONE hunk of the NEWEST history entry of a file (label "current": its diff is against the live file) ' +
    '(a backup of the current state is taken). An older entry is refused — use restore_backup for it. Needs confirmation.',
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
    // Дифф старой копии показан против СЛЕДУЮЩЕЙ копии, а откат считает «копия →
    // текущий файл»: тот же номер ханка вернул бы другие строки, чем на карточке.
    if (diff.label !== 'current') {
      throw new Error(
        `«${input.name}» is not the newest copy of ${diff.file}: only the newest entry of a file is reverted by hunk. ` +
          'Revert the matching lines of the newest entry, or restore_backup this copy as a whole.',
      );
    }
    const lines = maskedLines(diff.lines.filter((line) => line.hunk === input.hunk));
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
    'Backup copies of config files: name, target file, time, size, restorable, encrypted. Paged: follow nextOffset.',
  input: z.object({ offset, limit: z.number().int().min(1).max(200).default(30) }),
  route: () => ({ method: 'GET', url: '/api/backups' }),
  shape: (input, body) => {
    const info = body as BackupsInfo;
    const { meta, slice } = listPage(info.items, input.offset, input.limit);
    return {
      isEnabled: info.isEnabled,
      ...meta,
      items: slice.map((item) => ({ ...item, localTime: localTime(item.createdAt) })),
    };
  },
  summary: 'journal-list-backups',
});

/** Ответ `/api/backups/:name/preview`: дифф по файлу, секреты в строках уже замаскированы. */
interface RestorePreviewDiff {
  path: string;
  diff: string;
  added: number;
  removed: number;
  truncated: boolean;
  /** Двоичный файл, который откат заменит: строк нет, есть факт замены. */
  binary?: boolean;
}

/** Дифф отката: у двоичного файла вместо строк — пометка на языке окна. */
function binaryAware(files: readonly RestorePreviewDiff[], binaryNote: string): string {
  return files
    .map((file) =>
      file.binary ? `--- a/${file.path}\n+++ b/${file.path}\n(${binaryNote})` : file.diff,
    )
    .join('\n');
}

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
      // Дифф «файл → копия» из карточки: правка файла мимо панели копии не
      // заводит, а меняет, что снесёт откат, — клик по старой карточке запрещён.
      files: (
        await readRoute<{ files: RestorePreviewDiff[] }>(
          inject,
          `/api/backups/${encode(input.name)}/preview`,
        )
      ).files,
    }),
  preview: async (input, inject) => {
    const entry = await findBackup(inject, input.name);
    if (!entry.canRestore) throw new Error(`Backup «${entry.name}» has no place to restore to.`);
    if (entry.encrypted) {
      throw new Error(
        'Encrypted backup: the passphrase is entered only by the human on the History page.',
      );
    }
    // Откат пишет файл целиком: дифф «сейчас → станет» показывает и правки,
    // сделанные после копии, — они уйдут вместе с откатом.
    const { files } = await readRoute<{ files: RestorePreviewDiff[] }>(
      inject,
      `/api/backups/${encode(input.name)}/preview`,
    );
    const changed = files.filter((file) => file.truncated || file.binary || file.diff !== '');
    if (changed.length === 0) {
      throw new Error(
        `«${entry.target}» already matches backup «${entry.name}»: nothing to restore.`,
      );
    }
    // Карточку с неполным диффом одобрить нельзя (маршрут решения отвечает 409),
    // а откат на части не делится: без этого отказа агент выкладывал карточку-
    // тупик и узнавал об этом только по истечении ожидания (ревью z2 C17).
    const oversized = changed.filter((file) => file.truncated).map((file) => `«${file.path}»`);
    if (oversized.length > 0) {
      throw new Error(
        `The change to ${oversized.join(', ')} is too large to show line by line, so a ` +
          `confirmation card for it could not be approved. Tell the human to restore backup ` +
          `«${entry.name}» on the History page.`,
      );
    }
    return {
      ...card('summary-restore-backup', { target: entry.target }),
      fields: [
        dataField('label-backup', entry.name),
        ...changed.map((file) =>
          dataField(
            'label-file',
            file.binary ? file.path : `${file.path} (+${file.added} −${file.removed})`,
          ),
        ),
        dataField('label-created', localTime(entry.createdAt)),
      ],
      diff: binaryAware(changed, 'двоичный файл: откат заменит его копией целиком'),
      // Строка о двоичном файле — текст карточки, а не дифф: английскому окну своя.
      ...(changed.some((file) => file.binary)
        ? {
            diffEn: binaryAware(
              changed,
              'binary file: the restore replaces it with the copy whole',
            ),
          }
        : {}),
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
  readPassport,
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
