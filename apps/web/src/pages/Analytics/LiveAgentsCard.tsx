import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { useLiveAgents } from '@entities/Analytics';
import styles from './AnalyticsPage.module.scss';

/**
 * Что работает на машине сейчас. Данные обновляются сами каждые пять секунд:
 * это единственный по-настоящему живой блок страницы, остальное считается
 * по истории и так часто меняться не может.
 */
export function LiveAgentsCard() {
  const { t } = useTranslation();
  const { data } = useLiveAgents();
  const agents = data?.runningAgents ?? [];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('analytics.liveAgents')}
          </Typography>
          <Badge tone={agents.length > 0 ? 'success' : 'neutral'} withDot>
            {agents.length}
          </Badge>
        </Stack>

        <Typography variant="caption" color="subtle">
          {t('analytics.liveAgentsHint')}
        </Typography>

        {agents.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('analytics.noAgents')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-2xs)">
            {agents.map((agent) => (
              <Stack
                key={agent.pid}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-sm)"
                className={styles.agentRow}
              >
                <Typography variant="mono" as="span">
                  PID {agent.pid}
                </Typography>
                <Typography variant="body-sm" color="muted" as="span">
                  {agent.memoryMb} {t('common.megabytes')}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
