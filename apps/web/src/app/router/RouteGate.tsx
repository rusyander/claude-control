import type { ReactNode } from 'react';
import type { Capability } from '@claude-control/contracts';
import { useSettings } from '@entities/AppConfig';
import { useProviders, activeProvider } from '@entities/Provider';
import { SkeletonList } from '@shared/ui/skeleton';
import { ProviderSectionPlaceholder } from '@pages/ProviderSection/ProviderSectionPlaceholder';

interface RouteGateProps {
  capability: Capability;
  children: ReactNode;
}

/**
 * Гейт раздела на уровне маршрута. Решает, показать НАСТОЯЩУЮ страницу раздела
 * или заглушку «в разработке», исходя из активного провайдера.
 *
 * Быстрый путь для Claude (дефолт и подавляющий случай): если активный провайдер
 * — claude, страница рендерится сразу, БЕЗ ожидания `/api/providers`. Поведение
 * панели при Claude остаётся идентичным — гейт для него прозрачен.
 *
 * Для не-Claude провайдера ждём карту возможностей: пока грузится — скелетон (не
 * даём смонтировать настоящую страницу, чтобы `planned`-раздел ничего не
 * прочитал/записал). Дальше: `ready` → страница, иначе → заглушка. Так
 * соблюдается fail-closed.
 */
export function RouteGate({ capability, children }: RouteGateProps) {
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();

  // Пока настройки не пришли — считаем провайдера дефолтным (claude): для него
  // гейт прозрачен, а стороннего провайдера пользователь выбирает сам и редко.
  const providerId = settings?.provider ?? 'claude';
  if (providerId === 'claude') return <>{children}</>;

  if (!providers) return <SkeletonList rows={4} withActions={false} />;

  const active = activeProvider(providers);
  const status = active?.capabilities[capability] ?? 'unsupported';
  if (status === 'ready') return <>{children}</>;

  return (
    <ProviderSectionPlaceholder
      capability={capability}
      providerName={active?.name}
      access={status === 'planned' ? 'inDevelopment' : 'hidden'}
    />
  );
}
