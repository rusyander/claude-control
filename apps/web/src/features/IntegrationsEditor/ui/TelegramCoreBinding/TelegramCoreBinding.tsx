import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { useSetTelegramCoreOwner, useTelegramCoreBinding } from '../../api/telegramCoreBindingApi';
import { coreBindingState } from '../../model/telegramCoreBinding';
import styles from './TelegramCoreBinding.module.scss';
import { TelegramRepos } from './TelegramRepos';

export interface TelegramCoreBindingProps {
  /** Бот подключён (`isTelegramConnected`) — без него привязывать нечего. */
  connected: boolean;
}

/**
 * Привязка бота ответов к ядру задач (этап 12, D29): вопросы задач ядра приходят в бота кнопками.
 * Включение пишет в настройку ядра отпечаток чата бота (не номер), выключение — `null`; пишет окно
 * панели числом страницы, сам сервер панели настройку ядра не меняет (P187).
 */
export function TelegramCoreBinding({ connected }: TelegramCoreBindingProps): ReactNode {
  const { t } = useTranslation();
  const binding = useTelegramCoreBinding(connected);
  const save = useSetTelegramCoreOwner();
  if (!connected) return null;
  const view = binding.data;
  const state = coreBindingState(view);
  const fingerprint = view?.fingerprint ?? null;
  const usable = state === 'bound' || state === 'unbound';
  return (
    <div className={styles.root} data-telegram-core-binding={state}>
      <div className={styles.row}>
        <Toggle
          checked={state === 'bound'}
          onCheckedChange={(on) => save.mutate(on ? fingerprint : null)}
          disabled={!usable || save.isPending}
          aria-label={t('telegramAnswers.core.toggle')}
        />
        <Typography variant="body" as="span">
          {t('telegramAnswers.core.toggle')}
        </Typography>
      </div>
      <Typography variant="caption" color="subtle" as="span">
        {t(`telegramAnswers.core.${state}`)}
      </Typography>
      <Typography variant="caption" color="subtle" as="span">
        {t('telegramAnswers.core.hint')}
      </Typography>
      {save.isError ? (
        <Typography variant="caption" color="danger" as="span" role="alert">
          {t('telegramAnswers.core.failed', { reason: toErrorMessage(save.error) })}
        </Typography>
      ) : null}
      <TelegramRepos enabled={usable} />
    </div>
  );
}
