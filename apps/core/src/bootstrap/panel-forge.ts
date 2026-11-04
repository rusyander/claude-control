import { join } from 'node:path';
import {
  FORGE_CLOUD,
  hostOf,
  selectForge,
  siteBaseUrl,
  type ForgePort,
  type ForgeProject,
  type ForgeSites,
} from '@agentdeck/contracts/core/forge';
import { isKeysError } from '@agentdeck/keys/errors';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { readKeyStrict } from '@agentdeck/keys/provider-keys';
import { createForgePort } from '../adapters/forge/index.ts';
import type { NetFetch } from '../platform/net/net.types.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { panelAppDataDir } from './panel-profiles.ts';

/**
 * Форж проекта по настройкам панели — ТОЛЬКО чтение (05 §Push and MR, решение стадии 6): сайты
 * GitLab и GitHub лежат в открытом `state.json` панели (`settings.integrations`), значение
 * доступа — в её зашифрованном хранилище под именем `int:<вид>` (`@agentdeck/keys`). Ядро в
 * каталог панели не пишет; значение доступа живёт только в замыкании порта и в заголовке
 * запроса — наружу (журнал, procs.json, след) уходит лишь вид учётки (`credential`).
 */

export type ForgeCredential = 'stored' | 'missing' | 'unreadable' | 'not-needed';

export interface PanelForge {
  sites: ForgeSites;
  /** Записи, которые не прочитались: названы, а не пропали молча. */
  problems: string[];
}

export interface RemoteForge {
  project: ForgeProject;
  port: ForgePort;
  credential: ForgeCredential;
}

export interface PanelForgeDeps {
  /** Каталог данных панели; не задан — `panelAppDataDir()` (явная переменная или порядок панели). */
  appData?: string | undefined;
  fetch?: NetFetch;
  caCertPath?: string;
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function siteOf(raw: unknown): { enabled: boolean; baseUrl: string; repo: string } | undefined {
  if (!isObj(raw)) return undefined;
  return {
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    repo: typeof raw.repo === 'string' ? raw.repo : '',
  };
}

/** Сайты форжей из `<appData>/state.json`; нет каталога или файла — пусто (форж «другой»). */
export function readPanelForge(appData: string | undefined): PanelForge {
  const out: PanelForge = { sites: {}, problems: [] };
  if (!appData) return out;
  const file = join(appData, 'state.json');
  const bytes = readBytesSync(file);
  if ('absent' in bytes) return out;
  if (!('value' in bytes)) {
    out.problems.push(`${file}: ${bytes.unknown}`);
    return out;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.value.toString('utf8'));
  } catch (error) {
    out.problems.push(`${file}: not JSON (${(error as Error).message})`);
    return out;
  }
  const settings = isObj(doc) && isObj(doc.settings) ? doc.settings : {};
  const integrations = isObj(settings.integrations) ? settings.integrations : {};
  for (const kind of ['gitlab', 'github'] as const) {
    const site = siteOf(integrations[kind]);
    if (site) out.sites[kind] = site;
  }
  return out;
}

/** Значение доступа к форжу; непрочитанное хранилище — причина с кодом, не «ключа нет». */
function credentialOf(
  appData: string | undefined,
  kind: 'gitlab' | 'github',
): { token: string | null; credential: ForgeCredential; problem?: string } {
  if (!appData) return { token: null, credential: 'missing' };
  try {
    const token = readKeyStrict(appData, integrationKeyId(kind)) ?? null;
    return { token, credential: token ? 'stored' : 'missing' };
  } catch (error) {
    const code = isKeysError(error) ? error.code : 'unreadable';
    return {
      token: null,
      credential: 'unreadable',
      problem: `${kind} key store unreadable (${code})`,
    };
  }
}

/** Порт форжа для адреса remote: вид — по хосту (`selectForge`), доступ — из хранилища панели. */
export function forgeForRemote(url: string, deps: PanelForgeDeps = {}): RemoteForge {
  const appData = 'appData' in deps ? deps.appData : panelAppDataDir();
  const project = selectForge(url, readPanelForge(appData).sites);
  if (project.kind === 'generic')
    return { project, port: createForgePort({ project, token: null }), credential: 'not-needed' };
  const cred = credentialOf(appData, project.kind);
  const port = createForgePort({
    project,
    token: cred.token,
    ...(cred.problem ? { tokenProblem: cred.problem } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.caCertPath ? { caCertPath: deps.caCertPath } : {}),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  return { project, port, credential: cred.credential };
}

/**
 * Форж по каталогу панели, который уже решила загрузка (`panelWiring` → `panel.appData`): `null`
 * или нет — без панели. Каталог здесь не ищется: ядро в процессе теста с переданным каталогом
 * иначе прочло бы настоящие настройки форжа человека.
 */
export function forgeOfPanel(appData: string | null | undefined): (url: string) => RemoteForge {
  return (url) => forgeForRemote(url, { appData: appData ?? undefined });
}

/**
 * Хосты форжей для правила `forge-mcp-read-only` (P82): облака видов всегда, плюс сайт каждой
 * включённой настройки панели (своя инсталляция). Читается на каждом шаге — правка настроек
 * действует без перезапуска ядра; `null` каталога — только облака.
 */
export function forgeHostsOfPanel(appData: string | null | undefined): string[] {
  const hosts = new Set(Object.values(FORGE_CLOUD).map((url) => hostOf(url)));
  const { sites } = readPanelForge(appData ?? undefined);
  for (const kind of ['gitlab', 'github'] as const) {
    const site = sites[kind];
    if (site?.enabled) hosts.add(hostOf(siteBaseUrl(kind, site.baseUrl)));
  }
  hosts.delete('');
  return [...hosts];
}
