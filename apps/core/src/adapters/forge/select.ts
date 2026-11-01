import type { ForgeKind, ForgeProject } from '@agentdeck/contracts/core/forge';

/**
 * Какой форж за адресом remote (перенос логики хоста `forge-pick.ts` панели): хост адреса пуша
 * сравнивается с сайтом каждой включённой настройки (своя инсталляция — её `baseUrl`, иначе
 * github.com / gitlab.com). Совпадения нет — `generic` (пуш и ссылка), без угадывания по слову
 * в хосте: публикация чужим API хуже честного «этого форжа ядро не знает».
 */

export interface ForgeSite {
  enabled: boolean;
  /** Своя инсталляция; пусто — облако вида. */
  baseUrl: string;
  /** `group/name` или числовой id GitLab, `owner/repo` GitHub; пусто — из адреса remote. */
  repo: string;
}

export type ForgeSites = Partial<Record<Exclude<ForgeKind, 'generic'>, ForgeSite>>;

const CLOUD: Record<Exclude<ForgeKind, 'generic'>, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

/** Хост адреса: `https://x/y`, `ssh://git@x:22/y`, `git@x:y` → `x`; пусто — не разобрать. */
export function hostOf(url: string | undefined): string {
  const text = url?.trim() ?? '';
  const scheme = text.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (scheme?.[1]) return scheme[1].toLowerCase();
  const scp = text.match(/^[^@\s/]+@([^:/]+):/);
  return scp?.[1]?.toLowerCase() ?? '';
}

/** Путь проекта из адреса remote без `.git`; у своей инсталляции под путём — без него. */
export function projectPathOf(url: string, siteUrl = ''): string {
  const text = url.trim();
  let path: string;
  const scheme = text.match(/^[a-z+]+:\/\/[^/]+(\/.*)$/i);
  if (scheme?.[1]) path = scheme[1];
  else path = text.replace(/^[^@\s/]+@[^:/]+:/, '/');
  const sitePath = siteUrl ? siteUrl.replace(/^[a-z+]+:\/\/[^/]+/i, '').replace(/\/+$/, '') : '';
  if (sitePath && path.startsWith(`${sitePath}/`)) path = path.slice(sitePath.length);
  return path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
}

export function selectForge(pushUrl: string, sites: ForgeSites): ForgeProject {
  const host = hostOf(pushUrl);
  for (const kind of ['gitlab', 'github'] as const) {
    const site = sites[kind];
    if (!site?.enabled) continue;
    const baseUrl = site.baseUrl.trim().replace(/\/+$/, '') || CLOUD[kind];
    if (host && hostOf(baseUrl) === host) {
      return { kind, ref: site.repo.trim() || projectPathOf(pushUrl, baseUrl), baseUrl, pushUrl };
    }
  }
  return { kind: 'generic', ref: projectPathOf(pushUrl), baseUrl: '', pushUrl };
}
