import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { formatCompact } from '@shared/lib/format-number';
import { SessionActions } from './SessionActions';
import type { SessionsTabProps } from './SessionsTab.types';
import styles from './AnalyticsPage.module.scss';

/**
 * Вкладка «Сессии»: последние разговоры периода и оговорка про лимиты подписки.
 * У каждой строки — «Перейти» и, пока сессия идёт, «Остановить» (SessionActions).
 * Оговорка стоит здесь, а не в сводке: про лимиты спрашивают, глядя на сессии
 * («почему упёрся»), и ответ — что их остаток локально не узнать.
 */
export function SessionsTab({ sessions, locale }: SessionsTabProps) {
  const { t } = useTranslation();

  return (
    <>
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('analytics.recentSessions')}
          </Typography>

          <Stack>
            {sessions.map((session) => (
              <Stack
                key={session.sessionId}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-sm)"
                className={styles.sessionRow}
              >
                <Stack gap="var(--spacing-3xs)">
                  <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {session.displayName}
                    </Typography>
                    {session.isActive && (
                      <Badge tone="success" withDot>
                        {t('analytics.sessionActive')}
                      </Badge>
                    )}
                    {session.gitBranch && <Badge tone="neutral">{session.gitBranch}</Badge>}
                  </Stack>
                  <Typography variant="caption" color="subtle" as="span">
                    {new Date(session.lastActivity).toLocaleString(locale)} ·{' '}
                    {session.models.join(', ')}
                  </Typography>
                </Stack>

                <Stack
                  direction="row"
                  align="center"
                  gap="var(--spacing-sm)"
                  className={styles.sessionTail}
                >
                  <Typography variant="body-sm" color="muted" as="span">
                    {formatCompact(session.totals.total, locale)}
                  </Typography>
                  <SessionActions session={session} />
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-xs)" className={styles.limitsNote}>
          <Typography variant="body-sm" weight="medium">
            {t('analytics.limitsTitle')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('analytics.limitsText')}
          </Typography>
        </Stack>
      </Card>
    </>
  );
}
