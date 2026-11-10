import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { HELP_ROUTE } from '@shared/config/routes';
import { Icon } from '@shared/ui/icon';
import type { IntegrationStatus, IntegrationsSettings } from '@agentdeck/contracts';
import { serverFieldText } from '@shared/config/i18n';
import {
  useCheckIntegration,
  useForgetIntegration,
  useRestartTelegramAnswers,
  useSaveIntegration,
  useSaveTelegramCard,
  useTelegramAnswers,
  useTestTelegram,
} from '@entities/Integration';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import {
  answersBody,
  cardHealth,
  draftOfTelegram,
  isTelegramConnected,
  minutesValid,
  notifyBody,
  quietValid,
  saveTelegramCard,
} from '../../model/telegramCard';
import type { TelegramCardDraft } from '../../model/telegramCard.types';
import { showsAnswersToken } from '../../model/telegramAnswersView';
import { TelegramConnect } from '../TelegramConnect/TelegramConnect';
import { TelegramAdvanced } from '../TelegramAdvanced/TelegramAdvanced';
import { TelegramCoreBinding } from '../TelegramCoreBinding';
import { TelegramCardView } from './TelegramCardView';
import styles from './TelegramCard.module.scss';

/** Карточка Telegram с запросами: черновик, одно «Сохранить», выключатель. */
export function TelegramCard({
  status,
  settings,
}: {
  status: IntegrationStatus | undefined;
  settings: IntegrationsSettings;
}) {
  const { t } = useTranslation();
  const saved = settings.telegram;
  const answers = useTelegramAnswers();
  const view = answers.data;
  const saveCard = useSaveTelegramCard(saveTelegramCard);
  const saveIntegration = useSaveIntegration();
  const check = useCheckIntegration();
  const forget = useForgetIntegration();
  const testTelegram = useTestTelegram();
  const restart = useRestartTelegramAnswers();

  const fresh = () => draftOfTelegram(saved, view?.settings);
  const [draft, setDraft] = useState<TelegramCardDraft>(fresh);
  const [token, setToken] = useState('');
  const [answersToken, setAnswersToken] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [saveLine, setSaveLine] = useState<{ ok: boolean; text: string }>();

  // Черновик — из сохранённого, когда приехало новое сохранённое: опрос
  // состояния ответов каждые 10 с не стирает то, что человек сейчас правит.
  const savedKey = JSON.stringify([saved, view?.settings]);
  useEffect(() => {
    setDraft(fresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const connected = isTelegramConnected(status, saved);
  const baseline = fresh();
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) ||
    Boolean(token.trim()) ||
    Boolean(answersToken.trim());
  const valid =
    (!draft.finished || minutesValid(draft.doneAfterMinutes)) &&
    (!draft.waits || minutesValid(draft.afterMinutes)) &&
    (!draft.quietOn || quietValid(draft)) &&
    /^\d{0,20}$/.test(draft.ownerId.trim());

  const onSave = () => {
    setSaveLine(undefined);
    saveCard.mutate(
      {
        notify: notifyBody(draft, connected ? saved.enabled : Boolean(draft.chatId.trim())),
        ...(token.trim() ? { notifyToken: token.trim() } : {}),
        answers: {
          ...answersBody(draft),
          ...(answersToken.trim() ? { token: answersToken.trim() } : {}),
        },
      },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setToken('');
            setAnswersToken('');
            setSaveLine({ ok: true, text: t('telegramCard.saved') });
            return;
          }
          setSaveLine({
            ok: false,
            text: t(`telegramCard.failed.${result.failed}`, {
              error: toErrorMessage(result.error),
            }),
          });
        },
      },
    );
  };

  // Выключатель — отдельное действие с сохранённым, а не с черновиком: он
  // значит «писать и слушать или нет», и прятать его в «Сохранить» нельзя.
  const onMaster = (enabled: boolean) =>
    saveIntegration.mutate({ id: 'telegram', settings: { ...saved, enabled } });

  // «Проверить» до подключения: введённый токен сначала сохраняется.
  const onCheck = async () => {
    if (token.trim()) {
      await saveIntegration.mutateAsync({
        id: 'telegram',
        settings: { ...saved },
        token: token.trim(),
      });
      setToken('');
    }
    check.mutate('telegram');
  };

  const checkText = status?.detail ? serverFieldText(status, 'detail') : undefined;
  const ownerName = view?.settings.ownerName;
  const ownerLabel =
    ownerName && view?.settings.ownerId === saved.chatId
      ? ownerName
      : t('telegramCard.idOnly', { id: saved.chatId });

  const answersStateText = view?.settings.enabled
    ? t('telegramCard.advanced.answersState', {
        state: `${t(`telegramAnswers.state.${view.status.state}`)}${view.status.detail ? ` — ${view.status.detail}` : ''}`,
      })
    : undefined;

  return (
    <TelegramCardView
      connected={connected}
      enabled={saved.enabled}
      health={cardHealth({
        settings: saved,
        status,
        ...(view ? { answers: { settings: view.settings, status: view.status } } : {}),
      })}
      ownerLabel={ownerLabel}
      draft={draft}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onMaster={onMaster}
      masterBusy={saveIntegration.isPending}
      canSave={dirty && valid}
      saving={saveCard.isPending}
      onSave={onSave}
      {...(saveLine ? { saveLine } : {})}
      onTest={() => testTelegram.mutate()}
      testing={testTelegram.isPending}
      setup={{
        token,
        onToken: setToken,
        ...(status?.hasToken ? { maskedToken: status.maskedToken } : {}),
        onCheck: () => void onCheck(),
        checking: check.isPending || saveIntegration.isPending,
        ...(checkText ? { checkLine: { ok: status?.state === 'ok', text: checkText } } : {}),
      }}
      connect={<TelegramConnect hasToken={Boolean(status?.hasToken)} />}
      helpLink={
        <Link
          to={HELP_ROUTE}
          search={{ topic: 'integrations' }}
          className={styles.help}
          title={t('telegramCard.help')}
          aria-label={t('telegramCard.help')}
        >
          <Icon name="help" size={18} />
        </Link>
      }
      reconnecting={reconnecting}
      onReconnect={() => setReconnecting((open) => !open)}
      advanced={
        <>
          <TelegramAdvanced
            draft={draft}
            onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            token={token}
            onToken={setToken}
            {...(status?.hasToken ? { maskedToken: status.maskedToken } : {})}
            onForget={() => forget.mutate('telegram')}
            {...(view && showsAnswersToken(view)
              ? {
                  answersToken: {
                    value: answersToken,
                    onChange: setAnswersToken,
                    ...(view.hasToken ? { masked: view.maskedToken } : {}),
                  },
                }
              : {})}
            onCheck={() => check.mutate('telegram')}
            checking={check.isPending}
            {...(checkText ? { checkDetail: checkText } : {})}
            onRestart={() => restart.mutate()}
            restarting={restart.isPending}
            {...(status?.lastSend ? { lastSend: status.lastSend } : {})}
            {...(answersStateText ? { answersState: answersStateText } : {})}
          />
          <TelegramCoreBinding connected={connected} />
        </>
      }
    />
  );
}
