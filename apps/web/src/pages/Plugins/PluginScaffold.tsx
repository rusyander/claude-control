import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginScaffoldComponents } from '@claude-control/contracts';
import { useScaffoldPlugin } from '@entities/Plugin';
import { FolderPicker } from '@features/FolderPicker';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { Icon } from '@shared/ui/icon';
import type { ComponentKey } from './PluginScaffold.types';
import styles from './PluginsPage.module.scss';

const COMPONENT_KEYS: ComponentKey[] = ['commands', 'agents', 'skills', 'hooks'];

/**
 * Форма создания каркаса плагина.
 *
 * Папку выбирают через FolderPicker (тот же, что у проектов), поля манифеста
 * заполняют вручную, а состав — переключателями. Плагин ложится подпапкой
 * `<имя>` внутри выбранной папки; сервер отдаёт путь и список созданных файлов.
 */
export function PluginScaffold() {
  const { t } = useTranslation();
  const scaffold = useScaffoldPlugin();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [components, setComponents] = useState<PluginScaffoldComponents>({
    commands: true,
    agents: false,
    skills: false,
    hooks: false,
  });

  const created = scaffold.data?.ok ? scaffold.data : undefined;
  const canSubmit = Boolean(name.trim() && dir) && !scaffold.isPending;

  const submit = (): void => {
    if (!dir) return;
    scaffold.mutate({
      dir,
      name: name.trim(),
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      components,
    });
  };

  return (
    <details className={styles.manualInstall}>
      <summary>{t('plugins.scaffoldTitle')}</summary>

      <Stack gap="var(--spacing-sm)" className={styles.manualInstallBody}>
        <Typography variant="body-sm" color="muted" className="prose">
          {t('plugins.scaffoldHint')}
        </Typography>

        <TextField
          label={t('plugins.scaffoldName')}
          value={name}
          onChange={setName}
          placeholder="my-plugin"
          hint={t('plugins.scaffoldNameHint')}
          isMono
        />

        <TextField
          label={t('plugins.scaffoldDescription')}
          value={description}
          onChange={setDescription}
          placeholder={t('plugins.scaffoldDescriptionPlaceholder')}
        />

        <TextField label={t('plugins.scaffoldAuthor')} value={author} onChange={setAuthor} />

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="caption" color="subtle">
            {t('plugins.scaffoldFolder')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              leftIcon={<Icon name="folder" size={20} />}
              onClick={() => setIsPickerOpen(true)}
            >
              {t('plugins.scaffoldPickFolder')}
            </Button>
            {dir && (
              <Typography variant="mono" color="muted" as="span" truncate>
                {dir}
              </Typography>
            )}
          </Stack>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="caption" color="subtle">
            {t('plugins.scaffoldComponents')}
          </Typography>
          {COMPONENT_KEYS.map((key) => (
            <Stack key={key} direction="row" align="center" gap="var(--spacing-xs)">
              <Toggle
                checked={components[key]}
                onCheckedChange={(checked) =>
                  setComponents((prev) => ({ ...prev, [key]: checked }))
                }
                aria-label={t(`plugins.scaffoldComponent.${key}`)}
              />
              <Typography variant="body-sm" as="span">
                {t(`plugins.scaffoldComponent.${key}`)}
              </Typography>
            </Stack>
          ))}
        </Stack>

        <Stack direction="row">
          <Button
            variant="primary"
            onClick={submit}
            disabled={!canSubmit}
            isLoading={scaffold.isPending}
          >
            {t('plugins.scaffoldCreate')}
          </Button>
        </Stack>

        {created && (
          <Card padding="sm">
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" color="success">
                {t('plugins.scaffoldDone')}
              </Typography>
              <Typography variant="mono" color="muted" as="span" truncate>
                {created.path}
              </Typography>
              <Typography variant="caption" color="subtle">
                {created.created.join(', ')}
              </Typography>
            </Stack>
          </Card>
        )}
      </Stack>

      <FolderPicker
        isOpen={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        onPick={(path) => {
          setDir(path);
          setIsPickerOpen(false);
        }}
      />
    </details>
  );
}
