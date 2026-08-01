import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '@entities/Provider';
import { useProviderChecks, findCheck, trustBadge } from '@entities/ProviderCheck';
import type { ProviderTrustBadgeProps } from './ProviderTrustBadge.types';

/**
 * Бейдж доверия провайдера — тот же, что в селекторе, но пригодный к показу
 * ГДЕ УГОДНО (IDEA-9).
 *
 * Смысл в том, что настройки провайдера правятся не на странице выбора, а в
 * разделах: MCP, права, инструкции. Именно там важно знать, чей формат панель
 * сейчас пишет и проверялся ли он на этой машине — бейдж только в селекторе
 * человек видит один раз и забывает.
 *
 * Для Claude по умолчанию не рисуется ничего: он дефолт, и постоянная зелёная
 * плашка в каждом разделе была бы шумом, а не сведениями.
 */
export function ProviderTrustBadge({ providerId, showForClaude }: ProviderTrustBadgeProps) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();
  const { data: checks } = useProviderChecks();

  const id = providerId ?? settings?.provider ?? 'claude';
  if (id === 'claude' && !showForClaude) return null;

  const provider = providers?.providers.find((item) => item.id === id);
  if (!provider) return null;

  const check = findCheck(checks, id);
  const badge = trustBadge(provider.status, check);

  return (
    <Badge tone={badge.tone}>
      {t('providerCheck.badgeWithName', { name: provider.name, state: t(badge.key) })}
    </Badge>
  );
}
