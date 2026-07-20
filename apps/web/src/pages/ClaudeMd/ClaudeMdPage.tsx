import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { useClaudeMd, useUpdateClaudeMd } from '@entities/AppConfig';
import styles from './ClaudeMdPage.module.scss';

/**
 * Глобальный CLAUDE.md целиком. Раздел «Правила» разбирает его на карточки, но
 * там видно не всё — шапка, произвольные секции, порядок и форматирование. Здесь
 * файл открыт как есть: посмотреть, что вообще в нём лежит, и поправить руками.
 * Перед записью сервер делает резервную копию.
 */
export function ClaudeMdPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useClaudeMd();
  const update = useUpdateClaudeMd();
  const [value, setValue] = useState<string | undefined>(undefined);

  // Подхватываем содержимое, как только оно загрузилось.
  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data);
  }, [data, value]);

  if (isLoading || value === undefined) return <SkeletonList rows={6} withActions={false} />;

  const dirty = value !== data;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('claudeMd.title')}
        subtitle={t('claudeMd.subtitle')}
        helpTopic="claudeMd"
      />

      <ExplainBox title={t('claudeMd.explainTitle')} text={t('claudeMd.explain')} />

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <textarea
            className={styles.editor}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            aria-label={t('claudeMd.title')}
          />

          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Typography variant="caption" color="subtle">
              {t('claudeMd.chars', { count: value.length })}
              {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
            </Typography>

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setValue(data)}
                disabled={!dirty || update.isPending}
              >
                {t('claudeMd.revert')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="check" size={18} />}
                onClick={() => update.mutate(value)}
                isLoading={update.isPending}
                disabled={!dirty}
              >
                {t('common.save')}
              </Button>
            </Stack>
          </Stack>

          <Typography variant="caption" color="subtle">
            {t('common.needsRestart')}
          </Typography>
        </Stack>
      </Card>
    </Stack>
  );
}
