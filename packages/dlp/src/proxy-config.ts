import type { DlpSettings } from '@agentdeck/contracts';

/**
 * Куда прокси защиты данных пересылает запросы — одно правило для панели (проверка перед
 * включением) и ядра (настройка прокси на хосте звеньев): прямой адрес из настроек, иначе
 * `baseUrl` профиля эндпоинта `upstreamProfileId`. Пусто и там и там — прокси не поднимается:
 * догадаться про облако вендора нельзя, а поднявшийся «куда-нибудь» прокси увёл бы запросы
 * не туда, где их ждут.
 */

export type DlpUpstreamProblemCode =
  'dlp-upstream-missing' | 'dlp-upstream-unparsed' | 'dlp-upstream-scheme';

export type DlpUpstream =
  { url: string } | { code: DlpUpstreamProblemCode; detail: string; value?: string };

interface ProfileLike {
  id?: unknown;
  baseUrl?: unknown;
}

export function resolveDlpUpstream(
  dlp: Pick<DlpSettings, 'upstreamUrl' | 'upstreamProfileId'>,
  endpointProfiles: readonly unknown[],
): DlpUpstream {
  const direct = dlp.upstreamUrl.trim();
  if (direct) return httpUrl(direct);
  const profile = endpointProfiles.find(
    (item): item is ProfileLike =>
      typeof item === 'object' &&
      item !== null &&
      (item as ProfileLike).id === dlp.upstreamProfileId &&
      dlp.upstreamProfileId !== '',
  );
  if (typeof profile?.baseUrl === 'string' && profile.baseUrl) return httpUrl(profile.baseUrl);
  return { code: 'dlp-upstream-missing', detail: 'не задан адрес, куда пересылать запросы' };
}

function httpUrl(value: string): DlpUpstream {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { code: 'dlp-upstream-unparsed', detail: `адрес «${value}» не разбирается`, value };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return {
      code: 'dlp-upstream-scheme',
      detail: 'адрес должен начинаться с http:// или https://',
    };
  return { url: url.toString().replace(/\/+$/, '') };
}
