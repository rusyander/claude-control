import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { failureOf } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { useCoreConfig, useSaveCliPath } from '../../api/launchApi';
import { cliPathOf } from '../../model/cliOverride';
import { FailureNote } from '../FailureNote/FailureNote';

interface CliOverrideProps {
  adapter: string;
}

/**
 * Явный путь к CLI переходника (`cliPaths` настройки ядра): поиск не нашёл файл — человек
 * указывает его сам. Запись — `set-config` со строгим судом полномочий; отказ показан дословно.
 */
export function CliOverride({ adapter }: CliOverrideProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.roads.cli';
  const config = useCoreConfig();
  const save = useSaveCliPath();
  const current = cliPathOf(config.data, adapter);
  const [path, setPath] = useState('');

  const submit = (value: string) => {
    if (!config.data) return;
    save.mutate({ view: config.data, adapter, path: value });
  };

  return (
    <Stack gap="var(--spacing-xs)" data-cli-override={adapter}>
      <TextField
        label={t(`${P}.override`, { adapter })}
        hint={t(`${P}.overrideHint`)}
        value={path}
        onChange={setPath}
        isMono
      />
      {current && (
        <Typography variant="caption" color="muted" as="p">
          {t(`${P}.current`, { path: current })}
        </Typography>
      )}
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => submit(path)}
          disabled={!config.data || path.trim().length === 0}
          isLoading={save.isPending}
        >
          {t(`${P}.save`)}
        </Button>
        {current && (
          <Button size="sm" variant="ghost" onClick={() => submit('')} disabled={save.isPending}>
            {t(`${P}.clear`)}
          </Button>
        )}
      </Stack>
      {save.isSuccess && (
        <Typography variant="caption" color="success" as="p" role="status">
          {t(`${P}.saved`)}
        </Typography>
      )}
      {save.isError && <FailureNote failure={failureOf(save.error)} />}
    </Stack>
  );
}
