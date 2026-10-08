import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { formatCompact } from '@shared/lib/format-number';
import { SessionActions } from '../SessionActions/SessionActions';
import { SessionDetails } from '../SessionDetails/SessionDetails';
import type { SessionsTabProps } from './SessionsTab.types';
import styles from './SessionsTab.module.scss';
import { sessionBrief } from '../model/sessionBrief';

/**
 * Вкладка «Сессии»: последние разговоры периода и оговорка про лимиты подписки.
 * У каждой строки — «Перейти» и, пока сессия идёт, «Остановить» (SessionActions).
 * Оговорка стоит здесь, а не в сводке: про лимиты спрашивают, глядя на сессии
 * («почему упёрся»), и ответ — что их остаток локально не узнать.
 */
export function SessionsTab({ sessions, locale, providerId }: SessionsTabProps) {
  const { t } = useTranslation();

  return (
    <>
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body" weight="medium">
              {t('analytics.recentSessions')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('analytics.sessionsScopeNote')}
            </Typography>
          </Stack>

          <Stack>
            {sessions.map((session) => (
              <Stack key={session.sessionId} gap="var(--spacing-2xs)" className={styles.sessionRow}>
                <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
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
                    {session.title && (
                      <Typography variant="body-sm" color="muted" as="span">
                        {session.title}
                      </Typography>
                    )}
                    <Typography variant="caption" color="subtle" as="span">
                      {new Date(session.lastActivity).toLocaleString(locale)} ·{' '}
                      {session.models.join(', ')} ·{' '}
                      <span className={styles.nowrap}>{sessionBrief(session, t, locale)}</span>
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

                <SessionDetails session={session} locale={locale} />
              </Stack>
            ))}
          </Stack>
        </Stack>
      </Card>

      {!providerId && (
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
      )}
    </>
  );
}
