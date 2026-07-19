import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { EnvVar } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EnvFormModal } from '@features/EnvEditor';
import { DeleteButton } from '@features/EntityDelete';
import styles from './EnvPage.module.scss';

/**
 * Переменные окружения. Значения секретов приходят с сервера уже
 * замаскированными — полное значение запрашивается отдельно и только
 * по явному действию пользователя.
 */
export function EnvPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EnvVar | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const removeVar = useMutation({
    mutationFn: async (item: EnvVar) => {
      await apiClient.delete('/env', { params: { key: item.key, source: item.source } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
    },
  });

  const { data: vars = [], isLoading } = useQuery({
    queryKey: queryKeys.env,
    queryFn: async () => {
      const { data } = await apiClient.get<EnvVar[]>('/env');
      return data;
    },
  });

  const reveal = async (item: EnvVar): Promise<void> => {
    if (revealed[item.id]) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }

    const { data } = await apiClient.get<string>('/env/reveal', {
      params: { key: item.key, source: item.source },
    });
    setRevealed((current) => ({ ...current, [item.id]: data }));
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('env.title')}
        subtitle={t('env.subtitle')}
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => {
              setEditing(undefined);
              setIsFormOpen(true);
            }}
          >
            {t('env.addVar')}
          </Button>
        }
      />

      <ExplainBox title={t('env.explainTitle')} text={t('env.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      <Card padding="none">
        <Stack>
          {vars.map((item) => (
            <Stack
              key={item.id}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              className={styles.row}
            >
              <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="mono" weight="medium" as="span">
                    {item.key}
                  </Typography>
                  <Badge tone={item.source === 'secrets' ? 'warning' : 'neutral'}>
                    {item.source}
                  </Badge>
                </Stack>

                <Typography variant="mono" color="subtle" as="span" truncate>
                  {revealed[item.id] ?? item.value}
                </Typography>

                {item.comment && (
                  <Typography variant="caption" color="subtle" clamp={1} className={styles.comment}>
                    {item.comment}
                  </Typography>
                )}
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                {item.isSecret && (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name={revealed[item.id] ? 'eyeOff' : 'eye'} size={24} />}
                    aria-label={revealed[item.id] ? t('env.hideValue') : t('env.revealValue')}
                    onClick={() => void reveal(item)}
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${item.key}`}
                  onClick={() => {
                    setEditing(item);
                    setIsFormOpen(true);
                  }}
                />
                <DeleteButton
                  entityName={item.key}
                  description={t('env.deleteVar')}
                  onDelete={() => removeVar.mutate(item)}
                  isPending={removeVar.isPending}
                />
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Card>

      {!isLoading && vars.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <EnvFormModal isOpen={isFormOpen} onOpenChange={setIsFormOpen} envVar={editing} />
    </Stack>
  );
}
