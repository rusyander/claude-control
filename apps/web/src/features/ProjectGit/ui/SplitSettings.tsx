import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPLIT_MAX_GROUPS, SPLIT_SETTINGS_DEFAULT } from '@agentdeck/contracts/task-split';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useSplitSettings, useSaveSplitSettings } from '@entities/ProjectGit';
import type { SplitSettingsProps } from './SplitSettings.types';
import styles from './WorktreeMirrorSettings.module.scss';

/** Число групп разом: целое от 1 до потолка групп, иначе — не сохраняем. */
function parseParallel(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return value >= 1 && value <= SPLIT_MAX_GROUPS ? value : undefined;
}

/**
 * Разделение задач на этом проекте: доводить ли каждую группу до готового MR и
 * сколько групп работает одновременно. Хранится в панели по основной копии,
 * как и настройка копий, — группы разделения живут в копиях этого же проекта.
 *
 * Свёрнуто по умолчанию, как и соседняя настройка копий: нужно раз на проект.
 */
export function SplitSettings({ path, disabled }: SplitSettingsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Черновик — с первой правки, как у настройки копий: обновление с сервера
  // не затирает то, что человек ещё печатает.
  const [draft, setDraft] = useState<{ deliver: boolean; parallel: string } | undefined>(undefined);

  const settings = useSplitSettings(open ? path : undefined);
  const save = useSaveSplitSettings();

  const stored = settings.data ?? SPLIT_SETTINGS_DEFAULT;
  const deliver = draft?.deliver ?? stored.deliver;
  const parallelText = draft?.parallel ?? String(stored.parallel);
  const parallel = parseParallel(parallelText);
  const dirty = draft !== undefined;
  const locked = disabled || settings.isLoading;

  const onSave = (): void => {
    if (parallel === undefined) return;
    save.mutate(
      { path, deliver, parallel },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(t('git.worktrees.splitSaved'));
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
        {t('git.worktrees.splitSettings')}
      </Button>

      {open && (
        <Stack gap="var(--spacing-2xs)" className={styles.form}>
          <Stack gap="var(--spacing-3xs)">
            <Stack direction="row" align="center" gap="var(--spacing-2xs)">
              <Toggle
                size="sm"
                checked={deliver}
                disabled={locked}
                onCheckedChange={(value) => setDraft({ deliver: value, parallel: parallelText })}
                aria-label={t('git.worktrees.splitDeliver')}
              />
              <Typography variant="body-sm" as="span">
                {t('git.worktrees.splitDeliver')}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t('git.worktrees.splitDeliverHint')}
            </Typography>
          </Stack>
          <TextField
            label={t('git.worktrees.splitParallel')}
            value={parallelText}
            disabled={locked}
            hint={t('git.worktrees.splitParallelHint', { max: SPLIT_MAX_GROUPS })}
            error={
              parallel === undefined
                ? t('git.worktrees.splitParallelInvalid', { max: SPLIT_MAX_GROUPS })
                : undefined
            }
            onChange={(value) => setDraft({ deliver, parallel: value })}
          />
          <Stack direction="row" gap="var(--spacing-2xs)" justify="end">
            <Button
              variant="secondary"
              size="sm"
              isLoading={save.isPending}
              disabled={disabled || !dirty || parallel === undefined}
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
