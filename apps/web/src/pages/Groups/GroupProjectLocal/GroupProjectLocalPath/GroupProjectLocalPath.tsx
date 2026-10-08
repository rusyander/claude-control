import type { GroupProjectLocalPathProps } from '../GroupProjectLocal.types';
import { useTranslation } from 'react-i18next';
import { useProjectLocalByPath, ProjectLocalConfigView } from '@entities/Project';
import { Stack } from '@shared/ui/stack';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { Skeleton } from '@shared/ui/skeleton';

/** Один привязанный путь: запрос свой на каждый, поэтому и компонент отдельный. */
export function GroupProjectLocalPath({ path }: GroupProjectLocalPathProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProjectLocalByPath(path);

  return (
    <Stack gap="var(--spacing-2xs)">
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <Icon name="folder" size={16} />
        <Typography variant="mono" color="subtle" as="span" truncate title={path}>
          {path}
        </Typography>
      </Stack>
      {isLoading && <Skeleton height={24} width={280} />}
      {isError && (
        <Typography variant="caption" color="danger">
          {t('projectLocal.loadError')}
        </Typography>
      )}
      {data && <ProjectLocalConfigView config={data} compact />}
    </Stack>
  );
}
