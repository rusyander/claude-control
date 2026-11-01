import { useTranslation } from 'react-i18next';
import type { BadgeTone } from '@shared/ui/badge';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { CliWhere, RoadView } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';
import { CliOverride } from './CliOverride';

interface RoadsCardProps {
  roads: RoadView[];
}

const ROAD_TONE: Record<RoadView['status'], BadgeTone> = {
  ok: 'success',
  failed: 'danger',
  'not-checked': 'neutral',
};

const CLI_TONE: Record<CliWhere['state'], BadgeTone> = {
  found: 'success',
  absent: 'danger',
  refused: 'warning',
};

function CliRow({ cli }: { cli: CliWhere }) {
  const { t } = useTranslation();
  const P = 'coreLaunch.roads.cli';
  return (
    <div
      className={`${styles.row} ${cli.state === 'found' ? '' : styles.rowDanger}`}
      data-cli-adapter={cli.adapter}
      data-cli-state={cli.state}
    >
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {cli.adapter}
          </Typography>
          <Badge tone={CLI_TONE[cli.state]}>{t(`${P}.${cli.state}`)}</Badge>
          {cli.via && <Badge tone="neutral">{t(`${P}.via.${cli.via}`)}</Badge>}
        </Stack>
        {cli.where && (
          <Typography variant="caption" color="muted" as="p" className={styles.mono} data-cli-where>
            {cli.where}
          </Typography>
        )}
        {/* Не найден или отвергнут — строка ядра дословно: путь без причины не говорит, что чинить. */}
        {cli.state !== 'found' && (
          <Typography variant="caption" as="p" className={styles.mono} data-cli-reason>
            {cli.text}
          </Typography>
        )}
        {cli.state !== 'found' && cli.adapter !== '?' && <CliOverride adapter={cli.adapter} />}
      </Stack>
    </div>
  );
}

/**
 * Предпроверка по дорогам (окружение, CLI, маршруты…): каждая со статусом, строкой ядра и тем,
 * как исправить. У дороги `cli` — где найден CLI каждого переходника и поле явного пути.
 */
export function RoadsCard({ roads }: RoadsCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.roads';
  return (
    <LaunchSection title={t(`${P}.heading`)} name="roads">
      <Stack gap="var(--spacing-xs)">
        {roads.map((road) => (
          <div
            key={road.road}
            className={`${styles.row} ${road.status === 'failed' ? styles.rowDanger : ''}`}
            data-road={road.road}
            data-road-status={road.status}
          >
            <Stack gap="var(--spacing-xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Typography variant="body-sm" weight="medium" as="span" className={styles.mono}>
                  {road.road}
                </Typography>
                <Badge tone={ROAD_TONE[road.status]} withDot>
                  {t(`${P}.status.${road.status}`)}
                </Badge>
              </Stack>
              {road.cli === null && road.detail && (
                <Typography variant="caption" color="muted" as="p">
                  {road.detail}
                </Typography>
              )}
              {road.fix && (
                <Typography variant="caption" as="p" data-road-fix>
                  {t(`${P}.fix`, { fix: road.fix })}
                </Typography>
              )}
              {road.cli?.map((cli) => (
                <CliRow key={`${cli.adapter}:${cli.text}`} cli={cli} />
              ))}
            </Stack>
          </div>
        ))}
      </Stack>
    </LaunchSection>
  );
}
