import { z } from 'zod';
import type {
  ClaudeLocation,
  CliInfo as SettingsExtraCliInfo,
  CliUpdateResult as SettingsExtraCliUpdate,
  FormatCheckReport,
  FormatCheckResponse,
  ModelCatalogResponse as SettingsExtraModels,
  WatcherStatus as SettingsExtraWatcher,
} from '@agentdeck/contracts';
import type { SplitDefaults, SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import { SPLIT_HEAVY_RULE_MAX } from '@agentdeck/contracts/split-groups';
import { SPLIT_MAX_GROUPS } from '@agentdeck/contracts/task-split';
import type { AccountInfo as AccountInfoView } from '../../../domains/account.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, maskDeep, readRoute, stateCard } from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Настройки сверх `get_settings`/`update_settings`: общие правила групп
 * разделения, фоновый наблюдатель, каталог моделей, сверка форматов, учётная
 * запись и система, версия и обновление CLI Claude. Всё — теми же маршрутами,
 * что зовут карточки вкладок «Общие», «Группы», «Провайдеры», «Доступ».
 *
 * Права групп и развилки групп из общих правил агент НЕ меняет: это решения об
 * автоодобрении и о вопросах человеку (список «только человек», D2). Вход
 * действия этих полей не имеет, а запись несёт сохранённые значения как есть.
 */

const SPLIT_URL = '/api/split-defaults';

const count = (max: number) => z.number().int().min(1).max(max);

const splitInput = z
  .object({
    parallelLight: count(SPLIT_MAX_GROUPS)
      .optional()
      .describe('Groups running at once on a light project'),
    parallelHeavy: count(SPLIT_MAX_GROUPS)
      .optional()
      .describe('Groups running at once on a heavy project'),
    heavyChains: count(SPLIT_HEAVY_RULE_MAX)
      .optional()
      .describe('A project counts as heavy from this many chains'),
    heavySteps: count(SPLIT_HEAVY_RULE_MAX)
      .optional()
      .describe('A project counts as heavy from this many steps in a chain'),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Name at least one value to change',
  });
type SplitInput = z.infer<typeof splitInput>;

/** Правила после правки: названные числа поверх сохранённых, остальное как есть. */
function nextSplit(current: SplitDefaults, input: SplitInput): SplitDefaults {
  return {
    ...current,
    ...(input.parallelLight === undefined ? {} : { parallelLight: input.parallelLight }),
    ...(input.parallelHeavy === undefined ? {} : { parallelHeavy: input.parallelHeavy }),
    heavy: {
      chains: input.heavyChains ?? current.heavy.chains,
      steps: input.heavySteps ?? current.heavy.steps,
    },
  };
}

const readSplit = async (inject: InjectRoute) =>
  (await readRoute<SplitDefaultsView>(inject, SPLIT_URL)).defaults;

/** Числа правил — то, что агенту можно менять и что он читает. */
const splitNumbers = (defaults: SplitDefaults) => ({
  parallelLight: defaults.parallelLight,
  parallelHeavy: defaults.parallelHeavy,
  heavy: defaults.heavy,
});

const readSplitDefaults = definePanelAction({
  name: 'read_split_defaults',
  section: 'settings',
  risk: 'read',
  description:
    'Shared rules of split groups (Settings → Groups): how many groups run at once on a light and ' +
    'on a heavy project, and from how many chains/steps a project counts as heavy; plus the ' +
    'built-in values. Group permissions and group forks are listed read-only: only the human sets them.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: SPLIT_URL }),
  shape: (_input, body) => {
    const view = body as SplitDefaultsView;
    return {
      current: splitNumbers(view.defaults),
      builtIn: splitNumbers(view.builtIn),
      humanOnly: {
        permissions: view.defaults.permissions,
        groupQuestions: view.defaults.groupQuestions,
      },
    };
  },
  summary: 'journal-read-split-defaults',
});

const saveSplitDefaults = definePanelAction({
  name: 'save_split_defaults',
  section: 'settings',
  risk: 'change',
  title: 'journal-save-split-defaults',
  description:
    'Change the shared split-group numbers (groups at once on a light/heavy project, the heavy ' +
    'rule). Only the named values change. Needs the human’s confirmation. Group permissions and ' +
    'forks are not accepted here: the human sets them in Settings → Groups.',
  input: splitInput,
  route: async (input, inject) => ({
    method: 'PUT',
    url: SPLIT_URL,
    body: nextSplit(await readSplit(inject), input),
  }),
  fingerprint: async (_input, inject) => fingerprintOf(await readSplit(inject)),
  preview: async (input, inject) => {
    const current = await readSplit(inject);
    return stateCard(
      'split-defaults',
      splitNumbers(current),
      splitNumbers(nextSplit(current, input)),
      card('summary-save-split-defaults'),
      [textField('label-split-human-only', 'value-split-human-only')],
    );
  },
  shape: (_input, body) => ({
    saved: true,
    current: splitNumbers((body as SplitDefaultsView).defaults),
  }),
  page: () => ({ route: '/settings', focus: 'groups' }),
});

const WATCHER_URL = '/api/watcher';

const watcherView = (status: SettingsExtraWatcher) => ({
  enabled: status.enabled,
  ...(status.since ? { since: status.since } : {}),
  analyzing: status.analyzing,
  pendingSignals: status.pending,
  findings: status.findings,
  remarks: status.remarks,
});

const watcherStatus = definePanelAction({
  name: 'watcher_status',
  section: 'watcher',
  risk: 'read',
  description:
    'Background watcher (its own page, /watcher): on/off, since when, whether an analysis runs now, ' +
    'signals waiting, findings in its report.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: WATCHER_URL }),
  shape: (_input, body) => watcherView(body as SettingsExtraWatcher),
  summary: 'journal-watcher-status',
});

const setWatcher = definePanelAction({
  name: 'set_watcher',
  section: 'watcher',
  risk: 'change',
  title: 'journal-set-watcher',
  description:
    'Turn the background watcher on or off. When on, a model analyses page failures in the ' +
    'background and spends quota; off stops the analysis at once. Needs the human’s confirmation.',
  input: z.object({ enabled: z.boolean().describe('true = on, false = off') }),
  route: (input) => ({ method: 'POST', url: WATCHER_URL, body: { enabled: input.enabled } }),
  fingerprint: async (_input, inject) =>
    fingerprintOf((await readRoute<SettingsExtraWatcher>(inject, WATCHER_URL)).enabled),
  preview: async (input, inject) => {
    const status = await readRoute<SettingsExtraWatcher>(inject, WATCHER_URL);
    if (status.enabled === input.enabled) {
      throw new Error(
        `Nothing would change: the watcher is already ${input.enabled ? 'on' : 'off'}.`,
      );
    }
    return {
      ...card(input.enabled ? 'summary-watcher-on' : 'summary-watcher-off'),
      fields: [
        textField('label-watcher-cost', input.enabled ? 'value-watcher-cost' : 'value-watcher-off'),
      ],
    };
  },
  shape: (_input, body) => watcherView(body as SettingsExtraWatcher),
  page: () => ({ route: '/watcher' }),
});

const listModels = definePanelAction({
  name: 'list_models',
  section: 'settings',
  risk: 'read',
  description:
    'Model catalog the panel offers for Claude (Settings → Providers/Models): model ids and names, ' +
    'where the list came from (models.dev, a contour, none) and why it fell back. Never goes to a ' +
    'contour by itself. Paged: offset/limit.',
  input: z.object({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  route: () => ({ method: 'GET', url: '/api/models?provider=claude' }),
  shape: (input, body) => {
    const catalog = body as SettingsExtraModels;
    const slice = catalog.models.slice(input.offset, input.offset + input.limit);
    const end = input.offset + slice.length;
    return {
      source: catalog.source,
      requestedSource: catalog.requestedSource,
      ...(catalog.fallback ? { fallback: catalog.fallback } : {}),
      ...(catalog.platformTitle ? { contour: catalog.platformTitle } : {}),
      ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}),
      stale: catalog.stale,
      total: catalog.models.length,
      offset: input.offset,
      ...(end < catalog.models.length ? { nextOffset: end } : {}),
      models: slice.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.releaseDate ? { releaseDate: model.releaseDate } : {}),
      })),
    };
  },
  summary: 'journal-list-models',
});

const formatCheck = definePanelAction({
  name: 'format_check',
  section: 'settings',
  risk: 'read',
  description:
    'Check of other CLIs’ config formats against their published schemas (Settings → Providers): ' +
    'per CLI ok | drift | no-schema | unavailable and the keys missing from the schema. ' +
    'refresh=true checks now over the network; default returns the cached result.',
  input: z.object({ refresh: z.boolean().default(false) }),
  route: (input) =>
    input.refresh
      ? { method: 'POST', url: '/api/format-check/refresh' }
      : { method: 'GET', url: '/api/format-check' },
  shape: (input, body) => {
    // «Проверить сейчас» отвечает отчётом, чтение кэша — отчётом внутри ответа.
    const cached = input.refresh ? undefined : (body as FormatCheckResponse);
    const report = cached ? cached.report : (body as FormatCheckReport);
    if (!report)
      return { checked: false, note: 'Never checked yet; call again with refresh=true.' };
    return {
      checked: true,
      checkedAt: report.checkedAt,
      ...(cached ? { stale: cached.stale } : {}),
      providers: report.providers.map((provider) => ({
        cli: provider.providerId,
        state: provider.state,
        missingKeys: provider.keys.filter((key) => !key.present).map((key) => key.path),
        ...(provider.note ? { note: provider.note } : {}),
      })),
    };
  },
  summary: 'journal-format-check',
});

const readAccount = definePanelAction({
  name: 'read_account',
  section: 'settings',
  risk: 'read',
  description:
    'Who is signed in to Claude Code (name, email, organization, subscription or pay-as-you-go), ' +
    'the operating system and home folder, and which configuration folder the panel reads and why. ' +
    'Remaining limits are not known to the panel: they are shown by /usage in a Claude session.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/account' }),
  afterRoute: async (_input, body, inject) => ({
    account: body as AccountInfoView,
    system: await readRoute<Record<string, unknown>>(inject, '/api/system'),
    location: await readRoute<ClaudeLocation>(inject, '/api/location'),
  }),
  shape: (_input, body) => {
    const { account, system, location } = body as {
      account: AccountInfoView;
      system: Record<string, unknown>;
      location: ClaudeLocation;
    };
    return {
      account: account.email || account.displayName ? account : { signedIn: false },
      system,
      configFolder: {
        root: location.paths.root,
        chosenBy: location.source,
        valid: location.isValid,
        ...(location.missing.length ? { missing: location.missing } : {}),
        ...(location.problem ? { problem: location.problemCode ?? location.problem } : {}),
      },
    };
  },
  summary: 'journal-read-account',
});

const CLI_URL = '/api/chat/cli';

const cliView = (info: SettingsExtraCliInfo) => ({
  found: Boolean(info.path),
  ...(info.path ? { path: info.path } : {}),
  ...(info.version ? { version: info.version } : {}),
  copies: info.installs.map((install) => ({
    path: install.path,
    ...(install.version ? { version: install.version } : {}),
  })),
  ...(info.newer ? { newerCopy: info.newer } : {}),
});

const cliVersion = definePanelAction({
  name: 'cli_version',
  section: 'settings',
  risk: 'read',
  description:
    'Which CLI of the active provider the panel runs for chats: path, version, every copy in PATH, and a newer copy ' +
    'if the panel runs an older one.',
  input: z.object({
    refresh: z.boolean().default(false).describe('Ask each copy for --version again'),
  }),
  route: (input) => ({ method: 'GET', url: input.refresh ? `${CLI_URL}?refresh=1` : CLI_URL }),
  shape: (_input, body) => cliView(body as SettingsExtraCliInfo),
  summary: 'journal-cli-version',
});

const readCli = (inject: InjectRoute) =>
  readRoute<SettingsExtraCliInfo>(inject, `${CLI_URL}?refresh=1`);

const updateCli = definePanelAction({
  name: 'update_cli',
  section: 'settings',
  risk: 'danger',
  title: 'journal-update-cli',
  description:
    'Run the active provider CLI’s `update` subcommand for the copy the panel runs (up to 5 minutes; refused with a code for a CLI without a checked one). Needs the human’s ' +
    'confirmation. The result names the version after the update.',
  input: z.object({}),
  route: () => ({ method: 'POST', url: `${CLI_URL}/update` }),
  fingerprint: async (_input, inject) => {
    const info = await readCli(inject);
    return fingerprintOf({ path: info.path ?? null, version: info.version ?? null });
  },
  preview: async (_input, inject) => {
    const info = await readCli(inject);
    if (!info.path) {
      throw new Error(
        'The active provider’s CLI is not found in PATH: there is nothing to update.',
      );
    }
    return {
      ...card('summary-update-cli'),
      fields: [
        dataField('label-cli-path', info.path),
        info.version
          ? dataField('label-version', info.version)
          : textField('label-version', 'value-version-unknown'),
        textField('label-what-happens', 'value-update-cli-effect'),
      ],
    };
  },
  refusal: (body) => {
    const result = body as SettingsExtraCliUpdate;
    return result.ok
      ? undefined
      : `claude update failed: ${String(maskDeep(result.output.slice(-600)))}`;
  },
  shape: (_input, body) => {
    const result = body as SettingsExtraCliUpdate;
    return { updated: true, ...cliView(result.info), output: maskDeep(result.output.slice(-600)) };
  },
});

/** Настройки сверх общих: в порядке показа. */
export const SETTINGS_EXTRA_ACTIONS: readonly AnyPanelAction[] = [
  readSplitDefaults,
  saveSplitDefaults,
  watcherStatus,
  setWatcher,
  listModels,
  formatCheck,
  readAccount,
  cliVersion,
  updateCli,
];
