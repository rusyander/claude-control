import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { formatTokens } from '@shared/lib/format';
import { useLoweredRuns } from '@entities/Analytics';

/** Сколько последних прогонов показываем: карточка — сводка, а не журнал целиком. */
const ROWS = 8;

/**
 * Понижённые прогоны веера: сколько их было и у скольких панель НЕ ВИДЕЛА
 * прогона проверок.
 *
 * Блок существует потому, что планка сдачи до него была просьбой без сверки:
 * заданию дописывалась обязанность прогнать типы, линт и тесты — и верили на
 * слово. Панель не может заставить агента, но может смотреть, что он запускал,
 * и сказать об этом человеку.
 *
 * Формулировки намеренно осторожные. Видны только вызовы `Bash`: проверка,
 * запущенная своим скриптом-обёрткой или MCP-сервером, сюда не попадёт, поэтому
 * пустой список означает «панель не видела», а не «агент не проверял». Выдавать
 * второе за первое значило бы обвинять агента данными, которых у панели нет.
 */
export function LoweredRunsCard() {
  const { t } = useTranslation();
  const { data } = useLoweredRuns();
  const summary = data?.summary;

  // Пустой журнал не показываем вовсе: блок «понижений не было» на странице
  // аналитики — шум. Появится сам, как только веер уедет ступенью ниже.
  if (!summary || summary.total === 0) return null;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('analytics.lowered.title')}
          </Typography>
          <Badge tone="neutral">{summary.total}</Badge>
          {summary.withoutChecks > 0 && (
            <Badge tone="warning" withDot>
              {t('analytics.lowered.withoutChecks', { count: summary.withoutChecks })}
            </Badge>
          )}
          {summary.failed > 0 && (
            <Badge tone="danger">{t('analytics.lowered.failed', { count: summary.failed })}</Badge>
          )}
        </Stack>

        <Typography variant="caption" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('analytics.lowered.hint')}
        </Typography>

        {/* Разрез по классам работы: во что обошёлся каждый класс и как часто по
            нему доходило до проверок. Числа здесь для ЧЕЛОВЕКА — таблицу «класс →
            модель» правит он; агенту-классификатору цена классов не сообщается
            никогда, иначе он начнёт метить механикой всё подряд. */}
        {summary.byKind.length > 1 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="subtle" as="span">
              {t('analytics.lowered.byKind')}
            </Typography>
            {summary.byKind.map((row) => (
              <Stack
                key={row.kind || 'none'}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-xs)"
                wrap
              >
                <Typography variant="caption" as="span">
                  {row.kind || t('analytics.lowered.noKind')}
                </Typography>
                <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                  <Typography variant="caption" color="subtle" as="span">
                    {t('analytics.lowered.kindRuns', { count: row.total })}
                    {row.tokens > 0 ? ` · ${formatTokens(row.tokens)} tok` : ''}
                  </Typography>
                  {row.withoutChecks > 0 && (
                    <Badge tone="warning">
                      {t('analytics.lowered.withoutChecks', { count: row.withoutChecks })}
                    </Badge>
                  )}
                  {row.failed > 0 && (
                    <Badge tone="danger">
                      {t('analytics.lowered.failed', { count: row.failed })}
                    </Badge>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}

        <Stack gap="var(--spacing-2xs)">
          {(data?.runs ?? []).slice(0, ROWS).map((run) => (
            <Stack
              key={`${run.chatId}-${run.finishedAt}`}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-xs)"
              wrap
            >
              <Typography variant="mono" color="subtle" as="span" truncate>
                {run.projectPath ?? t('analytics.lowered.noProject')}
              </Typography>
              <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                <Typography variant="caption" color="subtle" as="span">
                  {run.model}
                  {run.effort ? ` · ${run.effort}` : ''}
                </Typography>
                {/* Упавший прогон проверок и не мог запустить — обвинять его в
                    несделанной планке сдачи было бы подлогом. */}
                {!run.ok ? (
                  <Badge tone="danger">{t('analytics.lowered.crashed')}</Badge>
                ) : (
                  <Badge tone={run.checks.length > 0 ? 'success' : 'warning'}>
                    {run.checks.length > 0
                      ? t('analytics.lowered.checksSeen', { count: run.checks.length })
                      : t('analytics.lowered.checksUnseen')}
                  </Badge>
                )}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
