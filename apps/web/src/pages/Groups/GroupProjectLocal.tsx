import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Skeleton } from '@shared/ui/skeleton';
import { ProjectLocalConfigView, useProjectLocalByPath } from '@entities/Project';
import { useProviders, activeProvider } from '@entities/Provider';
import type { GroupProjectLocalPathProps, GroupProjectLocalProps } from './GroupProjectLocal.types';
import styles from './GroupsPage.module.scss';

/**
 * «Из проекта» на карточке привязанной группы: собственный набор каждого
 * привязанного проекта — скиллы, хуки и правила из его `.claude`. Без этого
 * группа с привязкой выглядела пустой, хотя агент в ней работает с правилами и
 * скиллами проекта. Только чтение: набор принадлежит гиту проекта.
 */
export function GroupProjectLocal({ paths }: GroupProjectLocalProps) {
  const { t } = useTranslation();
  const { data: providers } = useProviders();

  // Набор `.claude` проекта есть только у Claude: сервер отвечает 400 любому
  // другому провайдеру (`requireClaudeProvider`), и страница проектов показывает
  // эту панель тем же правилом. Пока провайдеры не загружены — тоже ничего.
  const active = activeProvider(providers);
  if (active?.id !== 'claude') return null;

  return (
    <Stack gap="var(--spacing-xs)" className={styles.local}>
      <Typography variant="caption" color="subtle">
        {t('projectLocal.fromProject')}
      </Typography>
      {paths.map((path) => (
        <GroupProjectLocalPath key={path} path={path} />
      ))}
    </Stack>
  );
}

/** Один привязанный путь: запрос свой на каждый, поэтому и компонент отдельный. */
function GroupProjectLocalPath({ path }: GroupProjectLocalPathProps) {
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
