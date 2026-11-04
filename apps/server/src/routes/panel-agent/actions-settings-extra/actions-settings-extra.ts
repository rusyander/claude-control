import { z } from 'zod';
import type {
  ClaudeLocation,
  CliInfo as SettingsExtraCliInfo,
  CliUpdateResult as SettingsExtraCliUpdate,
  FormatCheckReport,
  FormatCheckResponse,
  ModelCatalogResponse as SettingsExtraModels,
} from '@agentdeck/contracts';
import type { AccountInfo as AccountInfoView } from '../../../domains/account.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, maskDeep, readRoute } from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Настройки сверх `get_settings`/`update_settings`: каталог моделей, сверка
 * форматов, учётная запись и система, версия и обновление CLI Claude. Всё —
 * теми же маршрутами, что зовут карточки вкладок «Общие», «Провайдеры», «Доступ».
 */

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
  listModels,
  formatCheck,
  readAccount,
  cliVersion,
  updateCli,
];
