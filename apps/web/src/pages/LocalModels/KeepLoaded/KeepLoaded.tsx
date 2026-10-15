import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { SelectField } from '@shared/ui/select-field';
import { isLocalIdleMinutes, localIdleMinutes } from '@agentdeck/contracts/local-models';
import { toast } from '@shared/lib/toast';
import { useSetKeepLoaded } from '@entities/LocalModels';
import type { KeepLoadedProps } from './KeepLoaded.types';

/**
 * «Держать загруженной» (L4). По умолчанию сервер выгружает модель из памяти после
 * пяти минут без запросов (`--sleep-idle-seconds`; на выбор 5, 15 или 60 минут): замер
 * 14.10 — видеопамять 7090 → 1842 МиБ, оперативная 4662 → 392 МиБ, возврат 4 секунды на 7B.
 * Человеку, который работает без пауз и не хочет ждать загрузки, выгрузка мешает — отсюда
 * выключатель и выбор срока.
 */
/** Подпись тоста: ждёт прогона, перезапущен или только запомнено до запуска. */
function savedKey(next: { restartPending?: boolean; running: boolean }): string {
  if (next.restartPending) return 'localModels.pending.saved';
  return next.running ? 'localModels.keepLoaded.saved' : 'localModels.keepLoaded.savedIdle';
}

/**
 * Срок выгрузки в минутах: свой у сервера и с записью кеша на диск. Панель пишет кеш перед
 * самым сном (за 45 с), а сервер считает запись работой и отсчитывает простой заново —
 * выходит почти вдвое дольше (замер 15.10).
 */
function idleMinutes(idleSeconds: number): { minutes: number; withSave: number } {
  const minutes = Math.round(idleSeconds / 60);
  return { minutes, withSave: Math.max(minutes, Math.floor((2 * idleSeconds) / 60) - 1) };
}

export function KeepLoaded({ info }: KeepLoadedProps) {
  const { t } = useTranslation();
  const set = useSetKeepLoaded();
  const { server } = info;
  const save = (body: Parameters<typeof set.mutate>[0]): void =>
    set.mutate(body, {
      // Перезапуск идёт, только если сервер работал; иначе настройка ждёт запуска.
      onSuccess: (next) => toast.success(t(savedKey(next))),
    });

  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Toggle
          checked={server.keepLoaded}
          disabled={set.isPending}
          aria-label={t('localModels.keepLoaded.toggle')}
          onCheckedChange={(keep) => save({ keepLoaded: keep })}
        />
        <Typography variant="body-sm">{t('localModels.keepLoaded.toggle')}</Typography>
      </Stack>
      {server.keepLoaded ? null : (
        <SelectField
          label={t('localModels.keepLoaded.idleLabel')}
          value={String(server.idleMinutes)}
          options={localIdleMinutes.map((minutes) => ({
            value: String(minutes),
            label: t(`localModels.keepLoaded.idle${minutes}`),
          }))}
          onChange={(value) => {
            const minutes = Number(value);
            if (isLocalIdleMinutes(minutes)) save({ keepLoaded: false, idleMinutes: minutes });
          }}
        />
      )}
      <Typography variant="caption" color="muted">
        {server.keepLoaded
          ? t('localModels.keepLoaded.on')
          : t('localModels.keepLoaded.off', idleMinutes(server.idleSeconds))}
      </Typography>
      {server.sleeping ? (
        <Typography variant="caption" color="muted" role="status" aria-live="polite">
          {t('localModels.keepLoaded.sleeping')}
        </Typography>
      ) : null}
    </Stack>
  );
}
