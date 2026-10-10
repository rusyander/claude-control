import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DiscoveredIntegration,
  IntegrationDiscovery,
  IntegrationId,
  IntegrationStatus,
  IntegrationsSettings,
} from '@agentdeck/contracts';
import { INTEGRATION_ORDER } from '@agentdeck/contracts/integrations';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { maskKey } from '../../../lib/provider-keys/provider-keys.ts';
import { readJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { readEnvLookup } from '../../env/env.ts';
import { invalidField } from '../errors.ts';
import {
  describeIntegration,
  readIntegrations,
  readToken,
  writeSettings,
  writeToken,
} from '../store/store.ts';
import { readLaunch, type RawServer, type VarLookup } from './launch.ts';
import { recognize } from './signatures.ts';

/**
 * «Найти уже подключённые»: интеграции, которые человек уже завёл как
 * MCP-серверы, — без повторного ввода адреса и ключа (владелец 10.10.2026).
 *
 * Смотрим туда же, откуда серверы берёт сам Claude Code: `mcpServers` в
 * `~/.claude.json` (общий блок и блоки проектов) и `.mcp.json` в корне каждого
 * известного проекта. Ключ найденного сервера НЕ покидает этот модуль: наружу —
 * маска; перенос называет кандидата по `key`, и сервер читает ключ заново из
 * того же источника, а не принимает его от клиента.
 */

export interface DiscoverPaths {
  /** `~/.claude.json`. */
  mcpConfig: string;
  /** `settings.json` и `settings.local.json`: их `env` получает каждый сервер. */
  settings: string;
  settingsLocal: string;
  /** Файл секретов панели (`.mcp-secrets.env`). */
  secretsEnv: string;
}

export interface DiscoverDeps {
  paths: DiscoverPaths;
  store: AppStore;
  appDataDir: string;
}

/** Кандидат с ключом — живёт только внутри сервера. */
interface Candidate extends Omit<
  DiscoveredIntegration,
  'hasToken' | 'maskedToken' | 'alreadyConnected' | 'replaces'
> {
  token: string;
}

interface ServerEntry {
  name: string;
  raw: RawServer;
  source: DiscoveredIntegration['source'];
  project?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serversOf(block: unknown): [string, RawServer][] {
  return isRecord(block)
    ? Object.entries(block).filter((entry): entry is [string, RawServer] => isRecord(entry[1]))
    : [];
}

/**
 * Свой переходник панели (`tools/mcp/atlassian.mjs`) — не чужое подключение:
 * он ходит в эту же панель, и «перенести» из него нечего.
 */
function isOwnProxy(raw: RawServer): boolean {
  const env = isRecord(raw.env) ? raw.env : {};
  const args = Array.isArray(raw.args) ? raw.args.join(' ') : '';
  return 'AGENTDECK_URL' in env || /tools[\\/]mcp[\\/]atlassian\.mjs/.test(args);
}

function collectServers(paths: DiscoverPaths, store: AppStore): ServerEntry[] {
  const config = readJsonFile<Record<string, unknown>>(paths.mcpConfig, {});
  const entries: ServerEntry[] = [];
  // Выключенные панелью серверы (`mcpServersDisabled`) — тоже подключения
  // человека: выключил сервер он, а интеграция ему может быть нужна.
  for (const block of [config.mcpServers, config.mcpServersDisabled]) {
    for (const [name, raw] of serversOf(block)) entries.push({ name, raw, source: 'user' });
  }

  const projects = new Set<string>();
  const projectBlocks = isRecord(config.projects) ? config.projects : {};
  for (const [project, value] of Object.entries(projectBlocks)) {
    projects.add(project);
    if (!isRecord(value)) continue;
    for (const [name, raw] of serversOf(value.mcpServers)) {
      entries.push({ name, raw, source: 'project', project });
    }
  }
  for (const project of store.getProjects()) projects.add(project.path);

  for (const project of projects) {
    const file = join(project, '.mcp.json');
    if (!existsSync(file)) continue;
    const local = readJsonFile<Record<string, unknown>>(file, {});
    for (const [name, raw] of serversOf(local.mcpServers)) {
      entries.push({ name, raw, source: 'mcp-json', project });
    }
  }
  return entries.filter((entry) => !isOwnProxy(entry.raw));
}

function candidateKey(entry: ServerEntry, id: IntegrationId): string {
  return [entry.source, entry.project ?? '', entry.name, id].join('|');
}

/** Найти кандидатов вместе с ключами. Ключи — только для `applyDiscovered`. */
function scan(deps: DiscoverDeps): { candidates: Candidate[]; scanned: number } {
  const lookup = readEnvLookup(
    deps.paths.settings,
    deps.paths.secretsEnv,
    deps.paths.settingsLocal,
  );
  const inherited: VarLookup = (name) => lookup[name] ?? process.env[name];
  const servers = collectServers(deps.paths, deps.store);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const entry of servers) {
    const launched = readLaunch(entry.raw, inherited);
    for (const found of recognize(launched, inherited)) {
      // Один и тот же доступ, описанный в нескольких местах (общий блок и
      // проект), — один кандидат: иначе карточка предлагала бы перенести одно
      // и то же дважды.
      const same = [found.id, found.fields.baseUrl ?? '', found.token].join('|');
      if (seen.has(same)) continue;
      seen.add(same);
      candidates.push({
        key: candidateKey(entry, found.id),
        id: found.id,
        server: entry.name,
        source: entry.source,
        ...(entry.project ? { project: entry.project } : {}),
        launch: launched.launch,
        package: launched.package,
        fields: Object.fromEntries(
          Object.entries(found.fields).filter(([, value]) => value !== ''),
        ),
        missing: found.required.filter((field) =>
          field === 'token' ? !found.token : !found.fields[field],
        ),
        token: found.token,
      });
    }
  }
  // Порядок карточки — порядок интеграций в настройках, а не серверов в файле.
  const rank = (id: IntegrationId): number => INTEGRATION_ORDER.indexOf(id);
  candidates.sort((a, b) => rank(a.id) - rank(b.id));
  return { candidates, scanned: servers.length };
}

const sameUrl = (a: string, b: string): boolean =>
  a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

/** Сравнить с тем, что уже подключено: тот же доступ или замена другого. */
function compare(
  deps: DiscoverDeps,
  candidate: Candidate,
): Pick<DiscoveredIntegration, 'alreadyConnected' | 'replaces'> {
  const current = readIntegrations(deps.store)[candidate.id] as unknown as Record<string, unknown>;
  const token = readToken(deps.appDataDir, candidate.id) ?? '';
  const differs = Object.entries(candidate.fields).filter(([field, value]) => {
    const saved = typeof current[field] === 'string' ? (current[field] as string) : '';
    // Вид установки дописывает живая проверка — пустой в находке не спорит с ним.
    if (field === 'deployment') return false;
    return !sameUrl(saved, value);
  });
  const tokenDiffers = Boolean(candidate.token) && token !== candidate.token;
  return {
    alreadyConnected: current.enabled === true && !tokenDiffers && differs.length === 0,
    replaces:
      (tokenDiffers && Boolean(token)) ||
      differs.some(([field]) => typeof current[field] === 'string' && current[field] !== ''),
  };
}

/** Что нашлось — без единого ключа: маска и признак «ключ есть». */
export function discoverIntegrations(deps: DiscoverDeps): IntegrationDiscovery {
  const { candidates, scanned } = scan(deps);
  return {
    scanned,
    found: candidates.map(({ token, ...candidate }) => ({
      ...candidate,
      hasToken: Boolean(token),
      maskedToken: token ? maskKey(token) : '',
      ...compare(deps, { ...candidate, token }),
    })),
  };
}

/**
 * Перенести выбранное. Кандидаты ищутся ЗАНОВО: между показом карточки и
 * нажатием конфигурацию могли поменять, а ключ от клиента сервер не принимает.
 * Отказ — до единой записи: неполный кандидат, исчезнувший или два кандидата
 * на одну интеграцию.
 */
export function applyDiscovered(deps: DiscoverDeps, keys: readonly string[]): IntegrationStatus[] {
  const { candidates } = scan(deps);
  const chosen = keys.map((key) => {
    const candidate = candidates.find((item) => item.key === key);
    if (!candidate) {
      throw invalidField(
        'keys',
        `сервер «${key}» больше не найден — обновите поиск`,
        'integration-discover-gone',
        {
          field: 'keys',
          key,
        },
      );
    }
    if (candidate.missing.length > 0) {
      throw invalidField(
        'keys',
        `у «${candidate.server}» не хватает: ${candidate.missing.join(', ')}`,
        'integration-discover-incomplete',
        { field: 'keys', server: candidate.server, missing: candidate.missing.join(', ') },
      );
    }
    return candidate;
  });
  const ids = chosen.map((candidate) => candidate.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) {
    throw invalidField(
      'keys',
      `для «${twice}» выбрано два сервера — оставьте один`,
      'integration-discover-twice',
      { field: 'keys', id: twice },
    );
  }

  for (const candidate of chosen) {
    const current = readIntegrations(deps.store)[candidate.id];
    writeSettings(deps.store, candidate.id, {
      ...current,
      ...candidate.fields,
      enabled: true,
    } as IntegrationsSettings[typeof candidate.id]);
    writeToken(deps.appDataDir, candidate.id, candidate.token);
    // Прежний итог проверки был про другой доступ — до новой проверки его нет.
    deps.store.forgetIntegrationHealth(`int:${candidate.id}`);
  }
  return chosen.map((candidate) => describeIntegration(deps.store, deps.appDataDir, candidate.id));
}
