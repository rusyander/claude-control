import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { useCompromises } from '@entities/Compromise';
import { CompromiseRow } from './CompromiseRow/CompromiseRow';

/**
 * Список подписанных компромиссов.
 *
 * Один компонент на два места — блок в разделе «Контур» и документ справки:
 * иначе два списка расходятся в первый же месяц, и человек читает в справке
 * то, чего в панели давно нет. Источник один и тот же — ответ сервера.
 */
export function CompromiseList() {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError, refetch } = useCompromises();

  if (isError && !data) return <LoadErrorCard onRetry={() => void refetch()} />;
  if (isLoading || !data) return <SkeletonList rows={3} withActions={false} />;

  const onScreen = data.filter((item) => !item.uiHidden);
  const hidden = data.filter((item) => item.uiHidden);

  return (
    <Stack gap="var(--spacing-md)">
      {onScreen.map((item) => (
        <CompromiseRow key={item.id} item={item} locale={i18n.language} />
      ))}

      {hidden.length > 0 && (
        <Stack gap="var(--spacing-xs)">
          {/* Обход без своего элемента на экране всё равно назван: тихо
              исчезнуть нельзя ни одному — на этом держится инвариант 12. */}
          <Typography variant="body-sm" weight="medium" as="h3">
            {t('compromise.hiddenGroup')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('compromise.hiddenGroupText')}
          </Typography>
          {hidden.map((item) => (
            <CompromiseRow key={item.id} item={item} locale={i18n.language} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
