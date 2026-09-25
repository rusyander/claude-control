import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPLIT_MAX_GROUPS } from '@agentdeck/contracts/task-split';
import { Stack } from '@shared/ui/stack';
import { CodeText, Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useSaveSplitSettings } from '@entities/ProjectGit';
import type { SplitSettingsProps } from './SplitSettings.types';
import styles from './DeliveryControl.module.scss';

/** Число групп разом: целое от 1 до потолка групп, иначе — не сохраняем. */
function parseParallel(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return value >= 1 && value <= SPLIT_MAX_GROUPS ? value : undefined;
}

/**
 * Доставка до MR на этом проекте — тело панели кнопки «До MR» в шапке чата.
 *
 * Тумблер сохраняется сразу, как и прочие тумблеры шапки: его трогают, чтобы
 * следующее сообщение ушло уже с ним. Число групп разом — полем с кнопкой: его
 * печатают, и сохранять каждую цифру значило бы гонять недописанное.
 *
 * Навык и подготовку копии панель выводит сама и только показывает: человеку
 * не нужно их настраивать, но видеть, что именно пойдёт, он должен.
 */
export function SplitSettings({ path, view }: SplitSettingsProps) {
  const { t } = useTranslation();
  const save = useSaveSplitSettings();
  // Черновик числа — с первой правки: обновление с сервера не затирает то, что
  // человек ещё печатает.
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const parallelText = draft ?? String(view.parallel);
  const parallel = parseParallel(parallelText);
  const { profile } = view;
  const pinned = view.parallelAuto ? null : view.parallel;

  const put = (body: { deliver: boolean; parallel: number | null }, onDone?: () => void): void => {
    save.mutate(
      { path, ...body },
      {
        onSuccess: () => {
          onDone?.();
          toast.success(t('chat.delivery.saved'));
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <Stack gap="var(--spacing-xs)">
      {!profile.remote && (
        <Typography variant="caption" color="warning" as="p" className={styles.note}>
          {t('chat.delivery.noRemote')}
        </Typography>
      )}

      <Stack as="label" direction="row" className={styles.toggleRow}>
        <Toggle
          size="sm"
          checked={view.deliver}
          disabled={save.isPending}
          onCheckedChange={(deliver) => put({ deliver, parallel: pinned })}
          aria-label={t('chat.delivery.deliver')}
        />
        <span className={styles.toggleText}>
          <Typography variant="body-sm" as="span">
            {t('chat.delivery.deliver')}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {t('chat.delivery.deliverHint')}
          </Typography>
        </span>
      </Stack>

      <Typography variant="caption" color="subtle" as="p" className={styles.note}>
        <CodeText
          text={
            profile.skill
              ? t('chat.delivery.skill', { name: profile.skill })
              : t('chat.delivery.skillNone')
          }
        />
      </Typography>

      <div className={styles.divider} />

      <TextField
        label={t('chat.delivery.parallel')}
        value={parallelText}
        disabled={save.isPending}
        hint={
          view.parallelAuto
            ? t('chat.delivery.parallelAuto', {
                reason: profile.heavy
                  ? t('chat.delivery.parallelHeavy')
                  : t('chat.delivery.parallelLight'),
                max: SPLIT_MAX_GROUPS,
              })
            : t('chat.delivery.parallelHint', { max: SPLIT_MAX_GROUPS })
        }
        error={
          parallel === undefined
            ? t('chat.delivery.parallelInvalid', { max: SPLIT_MAX_GROUPS })
            : undefined
        }
        onChange={setDraft}
      />
      <Stack direction="row" gap="var(--spacing-2xs)" justify="end">
        {!view.parallelAuto && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              put({ deliver: view.deliver, parallel: null }, () => setDraft(undefined))
            }
          >
            {t('chat.delivery.parallelReset')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          isLoading={save.isPending}
          disabled={draft === undefined || parallel === undefined}
          onClick={() =>
            parallel !== undefined &&
            put({ deliver: view.deliver, parallel }, () => setDraft(undefined))
          }
        >
          {t('chat.delivery.save')}
        </Button>
      </Stack>

      <div className={styles.divider} />

      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="subtle" as="span">
          {profile.bootstrapConfigured
            ? t('chat.delivery.bootstrapConfigured')
            : t('chat.delivery.bootstrapAuto')}
        </Typography>
        <Typography variant="caption" as="code" className={styles.command}>
          {profile.bootstrap ?? t('chat.delivery.bootstrapNone')}
        </Typography>
      </Stack>
    </Stack>
  );
}
