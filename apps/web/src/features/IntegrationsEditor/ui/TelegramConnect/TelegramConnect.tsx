import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TelegramConnectCandidate } from '@agentdeck/contracts/telegram-answers';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import {
  useCancelTelegramConnect,
  useConfirmTelegramConnect,
  useOpenTelegramConnect,
  useTelegramConnect,
} from '@entities/Integration';
import type { TelegramConnectBlockProps } from './TelegramConnect.types';
import styles from './TelegramConnect.module.scss';

/** «Анна (@anna)» — как человек узнаёт себя в Telegram. */
function nameOf(candidate: TelegramConnectCandidate): string {
  const name = candidate.firstName || candidate.id;
  return candidate.username ? `${name} (@${candidate.username})` : name;
}

/**
 * Подключение бота командой /start: кнопка открывает окно на пять минут,
 * карточка показывает ссылку на бота, потом пришедшего — «это вы?». Записывает
 * только подтверждение: `/start` может прислать кто угодно.
 *
 * Чистая часть отдельно от запросов — её рисуют проверки разметки.
 */
export function TelegramConnectBlock({
  view,
  hasToken,
  busy,
  onOpen,
  onConfirm,
  onCancel,
}: TelegramConnectBlockProps) {
  const { t, i18n } = useTranslation();
  const time = (iso: string | undefined) =>
    iso
      ? new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
      : '';
  const openButton = (label: string) => (
    <Button
      variant="secondary"
      size="sm"
      leftIcon={<Icon name="send" size={18} />}
      onClick={onOpen}
      isLoading={busy}
      disabled={!hasToken}
    >
      {label}
    </Button>
  );

  const link = view.link ? (
    <a className={styles.link} href={view.link} target="_blank" rel="noreferrer noopener">
      {view.link}
    </a>
  ) : null;

  const candidate = view.candidate;
  const body: Record<typeof view.state, ReactNode> = {
    idle: openButton(t('telegramAnswers.connect.open')),
    waiting: (
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap role="status">
        <Typography variant="body-sm" as="span">
          {t('telegramAnswers.connect.waiting', { time: time(view.expiresAt), link: '' })}
        </Typography>
        {link}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('telegramAnswers.connect.cancel')}
        </Button>
      </Stack>
    ),
    candidate: candidate ? (
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap role="status">
        <Typography variant="body-sm" weight="semibold" as="span">
          {t('telegramAnswers.connect.candidate', { name: nameOf(candidate), id: candidate.id })}
        </Typography>
        <Button variant="primary" size="sm" onClick={onConfirm} isLoading={busy}>
          {t('telegramAnswers.connect.confirm')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('telegramAnswers.connect.cancel')}
        </Button>
      </Stack>
    ) : null,
    expired: (
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Typography variant="body-sm" color="warning" as="span" role="status">
          {t('telegramAnswers.connect.expired')}
        </Typography>
        {openButton(t('telegramAnswers.connect.reopen'))}
      </Stack>
    ),
    confirmed: candidate ? (
      <Typography variant="body-sm" color="success" role="status">
        {t('telegramAnswers.connect.confirmed', { name: nameOf(candidate), id: candidate.id })}
      </Typography>
    ) : null,
    failed: (
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Typography variant="body-sm" color="danger" as="span" role="status">
          {view.reason ? t(`telegramAnswers.connect.reason.${view.reason}`) : ''}
          {view.detail ? ` — ${view.detail}` : ''}
        </Typography>
        {openButton(t('telegramAnswers.connect.reopen'))}
      </Stack>
    ),
  };

  return (
    <Stack gap="var(--spacing-2xs)" data-telegram-connect={view.state}>
      {body[view.state]}
      {hasToken ? null : (
        <Typography variant="caption" color="subtle">
          {t('telegramAnswers.connect.needToken')}
        </Typography>
      )}
    </Stack>
  );
}

/** Подключение по /start с запросами к серверу. */
export function TelegramConnect({ hasToken }: { hasToken: boolean }) {
  const connect = useTelegramConnect();
  const open = useOpenTelegramConnect();
  const confirm = useConfirmTelegramConnect();
  const cancel = useCancelTelegramConnect();
  return (
    <TelegramConnectBlock
      view={connect.data ?? { state: 'idle' }}
      hasToken={hasToken}
      busy={open.isPending || confirm.isPending}
      onOpen={() => open.mutate()}
      onConfirm={() => confirm.mutate()}
      onCancel={() => cancel.mutate()}
    />
  );
}
