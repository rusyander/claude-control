import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { LaunchBlocker } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';

interface LaunchCardProps {
  blockers: LaunchBlocker[];
  canLaunch: boolean;
  launching: boolean;
  launched: boolean;
  onLaunch: () => void;
}

/**
 * Кнопка запуска и всё, что её держит. Каждая причина названа строкой: серая кнопка без
 * объяснения заставила бы гадать, что ещё не сделано.
 */
export function LaunchCard({
  blockers,
  canLaunch,
  launching,
  launched,
  onLaunch,
}: LaunchCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.launch';
  return (
    <LaunchSection title={t(`${P}.heading`)} name="launch">
      <Stack gap="var(--spacing-sm)" data-launch-blockers={blockers.join(' ')}>
        {blockers.map((b) => (
          <Typography key={b} variant="caption" color="warning" as="p" data-launch-blocker={b}>
            {t(`${P}.blocker.${b}`)}
          </Typography>
        ))}
        {launched ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" color="success" as="p" role="status">
              {t(`${P}.started`)}
            </Typography>
            <div>
              <Link to={CORE_TASKS_ROUTE}>
                <Button variant="secondary">{t(`${P}.open`)}</Button>
              </Link>
            </div>
          </Stack>
        ) : (
          <div>
            <Button
              leftIcon={<Icon name="play" />}
              onClick={onLaunch}
              disabled={!canLaunch}
              isLoading={launching}
              data-launch-button
            >
              {t(`${P}.button`)}
            </Button>
          </div>
        )}
      </Stack>
    </LaunchSection>
  );
}
