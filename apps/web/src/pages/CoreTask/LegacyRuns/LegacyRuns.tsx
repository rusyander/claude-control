import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useLegacyRuns } from '../api/coreGroups';

/**
 * Прежние запуски групп — только чтение (этап 10, F1). Ядро их не подхватывает (Q10, спека 10:8):
 * у строки нет ни одной кнопки, и недоведённый запуск назван остановленным для ядра. Пустой
 * список не рисуется — раздел о прошлом не нужен тому, у кого прошлого нет.
 */
export function LegacyRuns() {
  const { t } = useTranslation();
  const runs = useLegacyRuns();
  const P = 'coreBoard.legacy';
  if (runs.isError) {
    return (
      <Typography variant="body-sm" color="subtle" data-legacy-runs-error>
        {t(`${P}.loadError`)}
      </Typography>
    );
  }
  const list = runs.data?.runs ?? [];
  if (list.length === 0) return null;
  return (
    <Stack gap="var(--spacing-xs)" data-legacy-runs>
      <Typography variant="body" weight="medium" as="h3">
        {t(`${P}.heading`)}
      </Typography>
      <Typography variant="body-sm" color="subtle">
        {t(`${P}.hint`)}
      </Typography>
      {list.map((run) => (
        <Card
          padding="md"
          key={run.parentChatId}
          data-legacy-run={run.parentChatId}
          data-legacy-state={run.state}
        >
          <Stack gap="var(--spacing-3xs)">
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Badge tone={run.state === 'half-run' ? 'warning' : 'neutral'}>
                {t(`${P}.state.${run.state}`)}
              </Badge>
              <Typography variant="caption" color="subtle" as="span">
                {new Date(run.createdAt).toLocaleString()}
              </Typography>
            </Stack>
            <Typography variant="mono" color="subtle" as="span">
              {run.projectPath}
            </Typography>
            {run.groups.map((group, index) => (
              // Номер группы в плане — её личность: названия и ветки могут совпасть.
              <Typography variant="body-sm" as="span" key={index}>
                {t(`${P}.group`, {
                  ...group,
                  status: t(`${P}.status.${group.status}`, { defaultValue: group.status }),
                })}
              </Typography>
            ))}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
