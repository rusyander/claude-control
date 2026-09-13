import { useTranslation } from 'react-i18next';
import type { CompromiseView } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { CodeText, Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { formatDate } from '@shared/lib/format';
import { useCompromises } from '@entities/Compromise';
import styles from './CompromiseList.module.scss';

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

function CompromiseRow({ item, locale }: { item: CompromiseView; locale: string }) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="baseline" wrap>
          <Typography variant="body" weight="medium" as="h4">
            {t(`compromise.items.${item.id}.name`)}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('compromise.headline', {
              severity: t(`compromise.severity.${item.severity}`),
              date: formatDate(item.since, locale),
            })}
          </Typography>
          {/* «Ещё не в коде» — не украшение: обещать проверенным то, что не
              написано, ровно та ложь, ради которой заведён инвариант 13. */}
          {item.planned && (
            <Typography variant="caption" color="warning" className={styles.planned}>
              {t('compromise.planned')}
            </Typography>
          )}
        </Stack>

        <Typography variant="body-sm">
          <CodeText text={t(`compromise.items.${item.id}.how`)} />
        </Typography>
        <Typography variant="body-sm" color="muted">
          <CodeText text={t(`compromise.items.${item.id}.why`)} />
        </Typography>
        <Typography variant="caption" color="muted">
          {t('compromise.revisit')}:{' '}
          <CodeText text={t(`compromise.items.${item.id}.revisitWhen`)} />
        </Typography>
        {item.uiHidden && (
          <Typography variant="caption" color="muted">
            {t(`compromise.items.${item.id}.hiddenReason`)}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
