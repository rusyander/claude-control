import type { ForgeKind, ForgeSettings } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { gitSync } from '../project-git/exec/exec.ts';
import { parseMergeRequestUrl } from './forge.ts';
import { FORGE_KINDS, forgeSettingsOf, forgeToken, isConnected } from './store/store.ts';

/**
 * Какой фордж обслуживает запрос, когда GitLab и GitHub подключены оба
 * (владелец 10.10.2026: каждая интеграция — своя).
 *
 * Ссылка (MR, issue) называет фордж сама — по ней и выбираем. Без ссылки —
 * проект: хост его origin. Один подключённый фордж выбирается без вопросов, как
 * было до разделения: у большинства он и есть один.
 */

export interface PickedForge {
  kind: ForgeKind;
  settings: ForgeSettings;
  token: string;
}

/** Хост адреса: `https://x/y`, `git@x:y` → `x`. Пусто, если адрес не разобрать. */
export function hostOf(url: string | undefined): string {
  const text = url?.trim() ?? '';
  const https = text.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (https?.[1]) return https[1].toLowerCase();
  const ssh = text.match(/^[^@\s]+@([^:]+):/);
  return ssh?.[1]?.toLowerCase() ?? '';
}

/** Хост, на котором живёт фордж этого вида: своя инсталляция или облако. */
function siteHost(kind: ForgeKind, settings: ForgeSettings): string {
  return hostOf(settings.baseUrl) || (kind === 'github' ? 'github.com' : 'gitlab.com');
}

function picked(store: AppStore, appDataDir: string, kind: ForgeKind): PickedForge | undefined {
  const token = forgeToken(store, appDataDir, kind);
  return token ? { kind, settings: forgeSettingsOf(store, kind), token } : undefined;
}

/**
 * Фордж для проекта или ссылки. `url` важнее `root`: дефект, заведённый в
 * GitHub, читается GitHub-ом и тогда, когда origin проекта смотрит в GitLab.
 */
export function pickForge(
  store: AppStore,
  appDataDir: string,
  where: { root?: string; url?: string } = {},
): PickedForge | undefined {
  const connected = FORGE_KINDS.filter((kind) => isConnected(store, appDataDir, kind));
  if (connected.length === 0) return undefined;
  if (connected.length === 1) return picked(store, appDataDir, connected[0]!);

  const host =
    hostOf(where.url) ||
    (where.root ? hostOf(gitSync(where.root, ['remote', 'get-url', 'origin']) ?? '') : '');
  const byHost = connected.find((kind) => siteHost(kind, forgeSettingsOf(store, kind)) === host);
  // Хост ни с одним не совпал — по названию в хосте (`gitlab.company.ru`),
  // иначе первый подключённый: отказ здесь хуже попытки, у которой есть ответ
  // форджа с причиной.
  const byName = connected.find((kind) => host.includes(kind));
  return picked(store, appDataDir, byHost ?? byName ?? connected[0]!);
}

/** Ключ форджа для ссылки на MR: вид берётся из самой ссылки. */
export function forgeTokenForUrl(
  store: AppStore,
  appDataDir: string,
  url: string,
): string | undefined {
  const kind = parseMergeRequestUrl(url)?.kind;
  return kind ? forgeToken(store, appDataDir, kind) : undefined;
}
