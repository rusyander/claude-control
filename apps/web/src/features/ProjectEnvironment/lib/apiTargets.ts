import type { ApiEnvUrl, ApiRunningService, ApiSpec } from '@entities/ApiExplorer';
import { isAbsoluteUrl } from './apiRequest';

/**
 * Подсказки базового адреса вкладки «API» и откуда каждая взялась. Порядок —
 * от вероятного к запасному: запущенный сервис проекта; адрес из `.env`, чей
 * хост начинается как у сервера контракта (`cp.` → `cp.dev.example.com`);
 * серверы контракта; прочие адреса `.env`. В `servers` контракта часто боевой
 * адрес или заглушка, а стенд для проверки записан в `.env` — поэтому он выше.
 */

export interface BaseSuggestion {
  url: string;
  origin: 'service' | 'env' | 'contract';
  /** Имя сервиса или `файл · КЛЮЧ` — подпись рядом с адресом. */
  note?: string;
  /** Адрес из `.env` основной копии: проект — копия задачи без своего `.env`. */
  main?: true;
}

const firstLabel = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.split('.')[0]?.toLowerCase();
  } catch {
    return undefined;
  }
};

export function baseSuggestions(
  spec: ApiSpec | undefined,
  services: ApiRunningService[],
  envUrls: ApiEnvUrl[] = [],
): BaseSuggestion[] {
  const servers = spec?.servers ?? [];
  const relative = servers.filter((server) => server.startsWith('/'));
  const absolute = servers.filter(isAbsoluteUrl);
  const labels = new Set(
    absolute.map(firstLabel).filter((label): label is string => Boolean(label)),
  );
  const fromEnv = (item: ApiEnvUrl): BaseSuggestion => ({
    url: item.url,
    origin: 'env',
    note: `${item.file} · ${item.key}`,
    ...(item.main ? { main: true as const } : {}),
  });
  const related = envUrls.filter((item) => labels.has(firstLabel(item.url) ?? ''));
  const list: BaseSuggestion[] = [
    ...services.flatMap((service) => [
      ...relative.map((server): BaseSuggestion => ({
        url: `${service.url}${server}`,
        origin: 'service',
        note: service.name,
      })),
      { url: service.url, origin: 'service' as const, note: service.name },
    ]),
    ...related.map(fromEnv),
    ...absolute.map((url): BaseSuggestion => ({
      url: url.replace(/\/+$/, ''),
      origin: 'contract',
    })),
    ...envUrls.filter((item) => !related.includes(item)).map(fromEnv),
  ];
  const seen = new Set<string>();
  return list.filter((item) => !seen.has(item.url) && Boolean(seen.add(item.url)));
}
