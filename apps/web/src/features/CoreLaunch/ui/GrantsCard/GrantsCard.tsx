import { useTranslation } from 'react-i18next';
import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import type { BadgeTone } from '@shared/ui/badge';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { GrantRow, GrantStatus } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';

interface GrantsCardProps {
  rows: GrantRow[];
  /** Ключ строки, чья команда в полёте. */
  granting: string | null;
  /** Задача уже не ждёт подтверждения (отказана или запущена) — кнопки не нужны. */
  closed: boolean;
  onConfirm: (grant: GrantConfirmation) => void;
}

const TONE: Record<GrantStatus, BadgeTone> = {
  confirmed: 'success',
  pending: 'warning',
  unreadable: 'danger',
};

/**
 * Гранты до запуска (06:108-112): пути задачи задевают маски, закрытые человеком без гранта.
 * Подтверждённой строку делает строка журнала `grant.given`, а не нажатие: пока её нет, запуск
 * заблокирован, и вопрос не всплывёт посреди шага.
 */
export function GrantsCard({ rows, granting, closed, onConfirm }: GrantsCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.grants';
  const opText = (ops: readonly string[]) => ops.map((op) => t(`${P}.op.${op}`)).join(', ');
  return (
    <LaunchSection title={t(`${P}.heading`)} hint={t(`${P}.hint`)} name="grants">
      <Stack gap="var(--spacing-xs)">
        {rows.length === 0 && (
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.empty`)}
          </Typography>
        )}
        {rows.map(({ key, grant, status }) => (
          <div
            key={key}
            className={`${styles.row} ${status === 'confirmed' ? '' : styles.rowWarn}`}
            data-grant-row={status}
          >
            <Stack gap="var(--spacing-3xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Typography variant="body-sm" weight="medium" as="span" className={styles.mono}>
                  {t(`${P}.repo`, { repo: grant.repoKey })}
                </Typography>
                <Badge tone={TONE[status]} withDot>
                  {t(`${P}.status.${status}`)}
                </Badge>
              </Stack>
              <Typography variant="caption" as="p" className={styles.mono}>
                {t(`${P}.globs`, { globs: grant.globs.join(', ') })}
              </Typography>
              <Typography variant="caption" as="p">
                {t(`${P}.ops`, { ops: opText(grant.ops) })}
              </Typography>
              {grant.matchedOwnedPaths.length > 0 && (
                <Typography variant="caption" color="muted" as="p" className={styles.mono}>
                  {t(`${P}.matched`, { paths: grant.matchedOwnedPaths.join(', ') })}
                </Typography>
              )}
              {status === 'pending' && !closed && (
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onConfirm(grant)}
                    isLoading={granting === key}
                    disabled={granting !== null && granting !== key}
                    data-grant-confirm
                  >
                    {t(`${P}.confirm`)}
                  </Button>
                </div>
              )}
            </Stack>
          </div>
        ))}
      </Stack>
    </LaunchSection>
  );
}
