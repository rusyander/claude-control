import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import { usePublishTestRun, type PublishTarget } from '@entities/ProjectTest';
import type { TestsRunPublishProps } from './TestsRunPublish.types';

/**
 * Публикация отчёта прогона наружу: страницей Confluence или комментарием в Jira.
 *
 * Куда именно — решает привязка проекта, а не эта форма: здесь выбирают только
 * СИСТЕМУ. Иначе пришлось бы спрашивать пространство, родителя и ключ задачи
 * при каждой публикации, а всё это уже сказано один раз в привязке.
 *
 * Ответом приходит адрес созданного, и он остаётся на экране: без него человек
 * не знает, обновилась существующая страница или завелась новая.
 */
export function TestsRunPublish({ projectPath, runId }: TestsRunPublishProps) {
  const { t } = useTranslation();
  const publish = usePublishTestRun(projectPath);
  const [target, setTarget] = useState<PublishTarget>('confluence');
  const [result, setResult] = useState<{ url: string; created: boolean } | undefined>();
  const [error, setError] = useState('');

  const submit = (): void => {
    setError('');
    publish
      .mutateAsync({ id: runId, target })
      .then((data) => setResult(data))
      .catch((cause: unknown) => setError(toErrorMessage(cause)));
  };

  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
        <SelectField
          label={t('tests.publish.target')}
          value={target}
          onChange={(value) => setTarget(value as PublishTarget)}
          options={[
            { value: 'confluence', label: t('tests.publish.confluence') },
            { value: 'jira', label: t('tests.publish.jira') },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="send" size={18} />}
          onClick={submit}
          isLoading={publish.isPending}
        >
          {t('tests.publish.action')}
        </Button>
      </Stack>

      {result && (
        <Typography variant="caption" color="success">
          {t(result.created ? 'tests.publish.created' : 'tests.publish.updated', {
            url: result.url,
          })}
        </Typography>
      )}

      {error && (
        <Typography variant="caption" color="danger">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
