import { useTranslation } from 'react-i18next';
import { useVerifyLedger } from '@entities/ProjectGit';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './VerifyLedgerCard.module.scss';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

const MODE_TONE = { shadow: 'accent', on: 'success', off: 'neutral', disabled: 'neutral' } as const;

/**
 * Журнал проверок (стадия 0 — тень): гейт на том же содержимом дерева мог бы
 * ответить записью прошлого прогона. Пока журнал только замеряет, плитка
 * отвечает на два вопроса, от которых зависит включение повторов: сколько это
 * сэкономило бы и расходилась ли запись с настоящим прогоном хоть раз.
 */
export function VerifyLedgerCard() {
  const { t } = useTranslation();
  const query = useVerifyLedger();
  const data = query.data;

  const body = () => {
    if (!data) {
      return (
        <Typography variant="body-sm" color="subtle">
          {query.isError ? toErrorMessage(query.error) : t('settings.verifyLedger.loading')}
        </Typography>
      );
    }
    const minutes = Math.round(data.savedMs / 60_000);
    const stats: Array<[string, string | number, boolean?]> = [
      [t('settings.verifyLedger.records'), data.records],
      [t('settings.verifyLedger.wouldSkip'), data.wouldSkip + data.hits],
      [t('settings.verifyLedger.saved'), t('settings.verifyLedger.minutes', { count: minutes })],
      [t('settings.verifyLedger.mismatches'), data.mismatches, data.mismatches > 0],
      [t('settings.verifyLedger.repos'), data.repos],
    ];
    return (
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone={data.active ? MODE_TONE[data.mode] : 'warning'}>
            {data.active
              ? t(`settings.verifyLedger.mode.${data.mode}`)
              : t('settings.verifyLedger.inactive')}
          </Badge>
          <Typography variant="caption" color="subtle" as="span">
            {data.active
              ? t('settings.verifyLedger.window', { count: data.windowDays })
              : (data.reason ?? '')}
          </Typography>
        </Stack>
        <dl className={styles.stats} data-verify-ledger-stats>
          {stats.map(([label, value, alarm]) => (
            <div key={label} className={styles.stat}>
              <dt>
                <Typography variant="caption" color="subtle" as="span">
                  {label}
                </Typography>
              </dt>
              <dd>
                <Typography
                  variant="body"
                  weight="medium"
                  color={alarm ? 'danger' : undefined}
                  as="span"
                >
                  {value}
                </Typography>
              </dd>
            </div>
          ))}
        </dl>
        <Typography variant="body-sm" color="subtle" data-verify-ledger-seen>
          {data.seen.length === 0
            ? t('settings.verifyLedger.seenNone')
            : t('settings.verifyLedger.seen', {
                list: data.seen.map((s) => s.cli).join(', '),
              })}
        </Typography>
      </Stack>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('settings.verifyLedger.title')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.verifyLedger.hint')}
          </Typography>
        </Stack>
        {body()}
      </Stack>
    </Card>
  );
}
