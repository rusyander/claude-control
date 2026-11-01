import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreRoutes } from '../api/useCoreRoutes';
import { routeLines, type TextRef } from '../model/routeLines';
import styles from './RoutesCard.module.scss';

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

/**
 * Маршруты моделей ядра (`GET /v1/routes`): вид, доступ (только наличие — значения ядро не
 * отдаёт), цена, предел, модели, исчерпание. 501 — ядро маршрутов ещё не отдаёт, это не сбой.
 */
export function RoutesCard() {
  const { t } = useTranslation();
  const P = 'coreLaunch.routes';
  const routes = useCoreRoutes();
  const text = (ref: TextRef) => t(ref.key, ref.params);
  let body;
  if (routes.isLoading) {
    body = null;
  } else if (routes.isError) {
    body = (
      <Typography
        variant="caption"
        color={statusOf(routes.error) === 501 ? 'muted' : 'danger'}
        as="p"
        data-routes-error={statusOf(routes.error) ?? 'network'}
      >
        {statusOf(routes.error) === 501 ? t(`${P}.notImplemented`) : t(`${P}.loadError`)}
      </Typography>
    );
  } else {
    const lines = routeLines(routes.data?.routes ?? []);
    body =
      lines.length === 0 ? (
        <Typography variant="caption" color="muted" as="p" data-routes-empty>
          {t(`${P}.empty`)}
        </Typography>
      ) : (
        <Stack gap="var(--spacing-xs)">
          {lines.map((line) => (
            <div key={line.id} className={styles.row} data-route={line.id}>
              <Stack gap="var(--spacing-3xs)">
                <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                  <Typography variant="body-sm" weight="medium" as="span" className={styles.mono}>
                    {line.id}
                  </Typography>
                  <Badge tone="neutral">{line.kind}</Badge>
                  {line.exhausted && (
                    <Badge tone="danger" withDot>
                      {t(`${P}.exhausted`)}
                    </Badge>
                  )}
                </Stack>
                <Typography variant="caption" as="p">
                  {[text(line.credential), text(line.price), text(line.limit)].join(' · ')}
                </Typography>
                <Typography variant="caption" color="muted" as="p" className={styles.mono}>
                  {line.models === null
                    ? t(`${P}.modelsUnknown`)
                    : t(`${P}.models`, { list: line.models.join(', ') })}
                </Typography>
              </Stack>
            </div>
          ))}
        </Stack>
      );
  }
  return (
    <Card padding="md" data-launch-section="routes">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2">
            {t(`${P}.heading`)}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.hint`)}
          </Typography>
        </Stack>
        {body}
      </Stack>
    </Card>
  );
}
