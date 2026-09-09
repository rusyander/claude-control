import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useMirrorSettings, useSaveMirrorSettings } from '@entities/ProjectGit';
import type { WorktreeMirrorSettingsProps } from './WorktreeMirrorSettings.types';
import styles from './WorktreeMirrorSettings.module.scss';

/**
 * Настройка копий на проекте: что переносить СВЕРХ встроенного списка зеркала,
 * что из него вычесть (по строке на шаблон, как в `.gitignore`) и какой командой
 * готовить копию после создания. Хранится в панели по основной копии — копия из
 * разделения задач получает то же самое.
 *
 * Свёрнуто по умолчанию: встроенного списка хватает почти всем, а два
 * текстовых поля в поповере git — лишний шум, пока они не понадобились.
 */
const toLines = (patterns: string[]): string => patterns.join('\n');
const fromLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export function WorktreeMirrorSettings({ path, disabled }: WorktreeMirrorSettingsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Черновик заводится при первой правке: до неё поля показывают сохранённое,
  // и обновление с сервера не затирает то, что человек ещё печатает.
  const [draft, setDraft] = useState<
    { include: string; exclude: string; bootstrap: string } | undefined
  >(undefined);

  const settings = useMirrorSettings(open ? path : undefined);
  const save = useSaveMirrorSettings();

  const stored = settings.data ?? { include: [], exclude: [] };
  const include = draft?.include ?? toLines(stored.include);
  const exclude = draft?.exclude ?? toLines(stored.exclude);
  const bootstrap = draft?.bootstrap ?? stored.bootstrap ?? '';
  const dirty = draft !== undefined;

  const onSave = (): void => {
    save.mutate(
      { path, include: fromLines(include), exclude: fromLines(exclude), bootstrap },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(t('git.worktrees.mirrorSaved'));
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.settings}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        leftIcon={<Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />}
        onClick={() => setOpen((value) => !value)}
      >
        {t('git.worktrees.mirrorSettings')}
      </Button>

      {open && (
        <Stack gap="var(--spacing-2xs)" className={styles.form}>
          <Typography variant="caption" color="subtle">
            {t('git.worktrees.mirrorBuiltin')}
          </Typography>
          <TextField
            label={t('git.worktrees.mirrorInclude')}
            value={include}
            multiline
            rows={3}
            isMono
            disabled={disabled || settings.isLoading}
            placeholder={t('git.worktrees.mirrorIncludePlaceholder')}
            onChange={(value) => setDraft({ include: value, exclude, bootstrap })}
          />
          <TextField
            label={t('git.worktrees.mirrorExclude')}
            value={exclude}
            multiline
            rows={2}
            isMono
            disabled={disabled || settings.isLoading}
            placeholder={t('git.worktrees.mirrorExcludePlaceholder')}
            hint={t('git.worktrees.mirrorPatternsHint')}
            onChange={(value) => setDraft({ include, exclude: value, bootstrap })}
          />
          <TextField
            label={t('git.worktrees.bootstrapCommand')}
            value={bootstrap}
            isMono
            disabled={disabled || settings.isLoading}
            placeholder={t('git.worktrees.bootstrapCommandPlaceholder')}
            hint={t('git.worktrees.bootstrapCommandHint')}
            onChange={(value) => setDraft({ include, exclude, bootstrap: value })}
          />
          <Stack direction="row" gap="var(--spacing-2xs)" justify="end">
            <Button
              variant="secondary"
              size="sm"
              isLoading={save.isPending}
              disabled={disabled || !dirty}
              onClick={onSave}
            >
              {t('git.worktrees.mirrorSave')}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
