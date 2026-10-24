import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  TelegramAnswersSave,
  TelegramAnswersState,
} from '@agentdeck/contracts/telegram-answers';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import {
  useRestartTelegramAnswers,
  useSaveTelegramAnswers,
  useTelegramAnswers,
} from '@entities/Integration';
import styles from './TelegramAnswers.module.scss';

const TONE: Record<TelegramAnswersState, 'success' | 'neutral' | 'warning' | 'danger'> = {
  off: 'neutral',
  polling: 'success',
  'no-token': 'warning',
  'owner-missing': 'warning',
  error: 'warning',
  'same-bot': 'danger',
  webhook: 'danger',
  conflict: 'danger',
  unauthorized: 'danger',
};

/** Подробность Telegram показываем там, где она что-то добавляет к строке состояния. */
const DETAILED: readonly TelegramAnswersState[] = ['conflict', 'unauthorized', 'error'];

/**
 * «Ответы из Telegram» на карточке Telegram: включить, через сколько минут
 * присылать, чей ответ принимать и каким ботом слушать. Токен отдельного бота
 * сервер не отдаёт — поле пустое, сохранённый виден маской.
 */
export function TelegramAnswers() {
  const { t } = useTranslation();
  const answers = useTelegramAnswers();
  const save = useSaveTelegramAnswers();
  const restart = useRestartTelegramAnswers();
  const view = answers.data;

  const [enabled, setEnabled] = useState(false);
  const [afterMinutes, setAfterMinutes] = useState('3');
  const [ownerId, setOwnerId] = useState('');
  const [token, setToken] = useState('');

  // Черновик — из сохранённого, один раз на приход настройки: опрос состояния
  // каждые 10 с не должен стирать то, что человек сейчас набирает.
  const saved = view?.settings;
  useEffect(() => {
    if (!saved) return;
    setEnabled(saved.enabled);
    setAfterMinutes(String(saved.afterMinutes));
    setOwnerId(saved.ownerId);
  }, [saved?.enabled, saved?.afterMinutes, saved?.ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return null;

  const minutes = Number(afterMinutes);
  const minutesValid = /^\d{1,4}$/.test(afterMinutes) && minutes <= 1440;
  const ownerValid = /^\d{0,20}$/.test(ownerId.trim());

  const submit = (extra: Partial<TelegramAnswersSave> = {}) => {
    const body: TelegramAnswersSave = {
      enabled,
      afterMinutes: minutes,
      ownerId: ownerId.trim(),
      ...(token.trim() ? { token: token.trim() } : {}),
      ...extra,
    };
    save.mutate(body, { onSuccess: () => setToken('') });
  };

  const { status } = view;
  return (
    <Stack gap="var(--spacing-xs)" className={styles.block}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Toggle
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('telegramAnswers.enabled')}
          size="sm"
        />
        <Typography variant="body-sm" weight="semibold" as="span">
          {t('telegramAnswers.title')}
        </Typography>
      </Stack>
      <Typography variant="caption" color="subtle" className="prose">
        {t('telegramAnswers.hint')}
      </Typography>

      <Stack direction="row" gap="var(--spacing-sm)" wrap>
        <div className={styles.narrow}>
          <TextField
            label={t('telegramAnswers.afterMinutes')}
            hint={t('telegramAnswers.afterMinutesHint')}
            value={afterMinutes}
            onChange={setAfterMinutes}
            {...(minutesValid ? {} : { error: '0…1440' })}
          />
        </div>
        <div className={styles.wide}>
          <TextField
            label={t('telegramAnswers.ownerId')}
            hint={t('telegramAnswers.ownerIdHint')}
            value={ownerId}
            onChange={setOwnerId}
            isMono
            {...(ownerValid ? {} : { error: '0-9' })}
          />
          {view.suggestedOwnerId && !ownerId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOwnerId(view.suggestedOwnerId ?? '')}
            >
              {t('telegramAnswers.useSuggested', { id: view.suggestedOwnerId })}
            </Button>
          ) : null}
        </div>
      </Stack>

      <TextField
        label={t('telegramAnswers.token')}
        hint={
          view.hasToken
            ? `${t('telegramAnswers.tokenSaved', { mask: view.maskedToken })} · ${t('telegramAnswers.tokenHint')}`
            : t('telegramAnswers.tokenHint')
        }
        value={token}
        onChange={setToken}
        placeholder={t('telegramAnswers.tokenPlaceholder')}
        type="password"
        isMono
      />
      {view.usesNotifyBot ? (
        <Typography variant="caption" color="subtle">
          {t('telegramAnswers.usesNotifyBot')}
        </Typography>
      ) : null}

      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        <Button
          variant="primary"
          size="sm"
          onClick={() => submit()}
          isLoading={save.isPending}
          disabled={!minutesValid || !ownerValid}
        >
          {t('telegramAnswers.save')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => restart.mutate()}
          isLoading={restart.isPending}
        >
          {t('telegramAnswers.restart')}
        </Button>
        {view.hasToken ? (
          <Button variant="ghost" size="sm" onClick={() => submit({ token: '' })}>
            {t('telegramAnswers.tokenClear')}
          </Button>
        ) : null}
      </Stack>

      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap role="status">
        <StatusDot tone={TONE[status.state]} pulse={status.state === 'polling'} />
        <Typography variant="body-sm" as="span">
          {t(`telegramAnswers.state.${status.state}`)}
          {status.detail && DETAILED.includes(status.state) ? ` — ${status.detail}` : ''}
        </Typography>
        {status.bot ? (
          <Typography variant="caption" color="subtle" as="span">
            {t('telegramAnswers.bot', { bot: status.bot })}
          </Typography>
        ) : null}
        {view.open > 0 ? (
          <Typography variant="caption" color="subtle" as="span">
            {t('telegramAnswers.open', { count: view.open })}
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}
