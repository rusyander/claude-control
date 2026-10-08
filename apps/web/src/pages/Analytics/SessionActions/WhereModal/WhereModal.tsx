import type { WhereModalProps } from '../SessionActions.types';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useProjectRegistry } from '@entities/Project';
import { samePath } from '../../model/sessionActions';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { hostLabel } from '../../lib/hostLabel';
import { SessionWhereDetails } from '../SessionWhereDetails/SessionWhereDetails';

/** Окно «Где идёт сессия» — для сессии вне панели: где, с какого времени и проект. */
export function WhereModal({ location, onClose }: WhereModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: projects } = useProjectRegistry();
  const project =
    location?.projectPath !== undefined
      ? projects?.find((item) => samePath(item.path, location.projectPath as string))
      : undefined;

  return (
    <Modal
      isOpen={location !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={t('analytics.sessionWhereTitle')}
      size="fit"
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button
            variant="primary"
            disabled={!project}
            onClick={() => {
              if (!project) return;
              onClose();
              void navigate({ to: '/projects', search: { id: project.id } } as never);
            }}
          >
            {t('analytics.sessionOpenProject')}
          </Button>
        </>
      }
    >
      {location && (
        <Stack gap="var(--spacing-md)">
          <Typography variant="body-sm" role="status">
            {location.where.kind === 'process'
              ? hostLabel(location, t)
              : t('analytics.sessionWhereUnidentified')}
          </Typography>
          <SessionWhereDetails location={location} />
          {!project && (
            <Typography variant="caption" color="subtle">
              {t('analytics.sessionProjectNotAdded')}
            </Typography>
          )}
        </Stack>
      )}
    </Modal>
  );
}
