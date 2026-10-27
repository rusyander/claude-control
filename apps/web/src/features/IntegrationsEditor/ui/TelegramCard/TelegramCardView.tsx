import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { integrationAnchor } from '@entities/PanelAgent';
import type { CardHealth, HealthReason } from '../../model/telegramCard';
import { TelegramWhen } from '../TelegramWhen/TelegramWhen';
import type { TelegramCardViewProps, TelegramSetupProps } from './TelegramCard.types';
import styles from './TelegramCard.module.scss';

const TONE = { off: 'neutral', ok: 'success', error: 'danger' } as const;

/** Причина ошибки — словами, без кодов. */
function useReasonText(): (reason: HealthReason) => string {
  const { t } = useTranslation();
  return (reason) => {
    if (reason.kind === 'check') return reason.text;
    if (reason.kind === 'send') return t('telegramCard.reason.send', { text: reason.text });
    return t(`telegramCard.reason.answers.${reason.state}`);
  };
}

function HealthLine({ health, connected }: { health: CardHealth; connected: boolean }) {
  const { t } = useTranslation();
  const reasonText = useReasonText();
  if (!connected) {
    return (
      <span className={styles.status} role="status">
        <StatusDot tone="neutral" />
        <Typography variant="body-sm" color="subtle" as="span">
          {t('telegramCard.state.notConnected')}
        </Typography>
      </span>
    );
  }
  const text: Record<CardHealth['tone'], string> = {
    off: t('telegramCard.state.off'),
    ok:
      health.tone === 'ok' && health.bot
        ? t('telegramCard.state.okBot', { bot: health.bot })
        : t('telegramCard.state.ok'),
    error:
      health.tone === 'error'
        ? t('telegramCard.state.error', { reason: reasonText(health.reason) })
        : '',
  };
  return (
    <span className={styles.status} role="status" data-telegram-health={health.tone}>
      <StatusDot tone={TONE[health.tone]} />
      <Typography
        variant="body-sm"
        color={health.tone === 'error' ? 'danger' : 'default'}
        as="span"
      >
        {text[health.tone]}
      </Typography>
    </span>
  );
}

/** Шаг 1 до подключения: токен бота и «Проверить». */
function Setup({ token, onToken, maskedToken, onCheck, checking, checkLine }: TelegramSetupProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap className={styles.step}>
      <Stack flex={1} minWidth="240px">
        <TextField
          label={`${t('telegramCard.setup.bot')} · ${t('telegramCard.setup.token')}`}
          type="password"
          value={token}
          onChange={onToken}
          placeholder={t('telegramAnswers.tokenPlaceholder')}
          hint={
            maskedToken
              ? t('telegramCard.setup.tokenSaved', { mask: maskedToken })
              : t('telegramCard.setup.tokenHint')
          }
          {...(checkLine && !checkLine.ok ? { error: checkLine.text } : {})}
          isMono
        />
      </Stack>
      <Button variant="secondary" size="sm" onClick={onCheck} isLoading={checking}>
        {t('telegramCard.setup.check')}
      </Button>
      {checkLine?.ok ? (
        <Typography variant="caption" color="success" role="status">
          {checkLine.text}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * Карточка Telegram (переделка 25.10.2026 по «мешанине» владельца).
 *
 * Не подключено — два шага: бот (токен, «Проверить») и вы («Подключить», /start).
 * Подключено — главный выключатель, состояние одним словом, кому пишет, «Когда
 * звать» тремя группами, «Отправить пробное» и одно «Сохранить»; редкое — в
 * «Дополнительно». Длинные объяснения — в справке по «?».
 */
export function TelegramCardView(props: TelegramCardViewProps) {
  const { t } = useTranslation();
  const { connected, enabled, health, draft } = props;
  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)" data-telegram-card={connected ? 'connected' : 'setup'}>
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-xs)"
            wrap
            data-agent-anchor={integrationAnchor('telegram')}
          >
            <Typography variant="body" weight="medium" as="span">
              {t('integrations.card.telegram.title')}
            </Typography>
            <HealthLine health={health} connected={connected} />
            {props.helpLink}
          </Stack>
          {connected ? (
            <Toggle
              checked={enabled}
              onCheckedChange={props.onMaster}
              disabled={props.masterBusy}
              aria-label={t('telegramCard.master')}
            />
          ) : null}
        </Stack>

        {connected ? null : (
          <>
            <Setup {...props.setup} />
            <Stack gap="var(--spacing-2xs)" className={styles.step}>
              <Typography variant="body-sm" weight="semibold" as="span">
                {t('telegramCard.setup.you')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('telegramCard.setup.youHint')}
              </Typography>
              {props.connect}
            </Stack>
            {props.advanced}
            {/* Ручной путь (чат и id в «Дополнительно») сохраняется тем же «Сохранить». */}
            {props.canSave ? (
              <Stack direction="row" justify="end">
                <Button variant="primary" size="sm" onClick={props.onSave} isLoading={props.saving}>
                  {t('telegramCard.save')}
                </Button>
              </Stack>
            ) : null}
          </>
        )}

        {connected ? (
          <>
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="caption" color="subtle" as="span">
                {t('telegramCard.you')}
              </Typography>
              <Typography variant="body-sm" weight="semibold" as="span" data-telegram-owner>
                {props.ownerLabel}
              </Typography>
              <Button variant="ghost" size="sm" onClick={props.onReconnect}>
                {t('telegramCard.reconnect')}
              </Button>
            </Stack>
            {props.reconnecting ? props.connect : null}
            <TelegramWhen draft={draft} onChange={props.onChange} />
            <Stack direction="row" gap="var(--spacing-xs)" justify="end" align="center" wrap>
              {props.saveLine ? (
                <Typography
                  variant="caption"
                  color={props.saveLine.ok ? 'success' : 'danger'}
                  role="status"
                  data-telegram-save={props.saveLine.ok ? 'ok' : 'failed'}
                >
                  {props.saveLine.text}
                </Typography>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="send" size={18} />}
                onClick={props.onTest}
                isLoading={props.testing}
              >
                {t('telegramCard.test')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="check" size={18} />}
                onClick={props.onSave}
                isLoading={props.saving}
                disabled={!props.canSave}
              >
                {t('telegramCard.save')}
              </Button>
            </Stack>
            {props.advanced}
          </>
        ) : null}
      </Stack>
    </Card>
  );
}
