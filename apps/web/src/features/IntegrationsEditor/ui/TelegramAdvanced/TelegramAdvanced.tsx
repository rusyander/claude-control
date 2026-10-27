import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { TelegramLastSendLine } from '../TelegramLastSendLine/TelegramLastSendLine';
import type { TelegramAdvancedProps } from './TelegramAdvanced.types';
import styles from './TelegramAdvanced.module.scss';

/**
 * «Дополнительно» карточки Telegram: всё, что нужно редко или при поломке, —
 * ваш id вручную, токены, бюджет контура, переподключение бота, последняя
 * отправка и состояние ответов. На виду этого нет: владельцу (25.10.2026) это
 * читалось «мешаниной».
 */
export function TelegramAdvanced({
  draft,
  onChange,
  token,
  onToken,
  maskedToken,
  onForget,
  answersToken,
  onCheck,
  checking,
  checkDetail,
  onRestart,
  restarting,
  lastSend,
  answersState,
}: TelegramAdvancedProps) {
  const { t } = useTranslation();
  return (
    <details className={styles.details} data-telegram-advanced>
      <summary>{t('telegramCard.advanced.title')}</summary>
      <Stack gap="var(--spacing-xs)" className={styles.body}>
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Stack flex={1} minWidth="200px">
            <TextField
              label={t('telegramCard.advanced.chatId')}
              hint={t('telegramCard.advanced.chatIdHint')}
              value={draft.chatId}
              onChange={(chatId) => onChange({ chatId })}
              isMono
            />
          </Stack>
          <Stack flex={1} minWidth="200px">
            <TextField
              label={t('telegramCard.advanced.ownerId')}
              hint={t('telegramCard.advanced.ownerIdHint')}
              value={draft.ownerId}
              onChange={(ownerId) => onChange({ ownerId })}
              isMono
              {...(/^\d{0,20}$/.test(draft.ownerId.trim()) ? {} : { error: '0-9' })}
            />
          </Stack>
        </Stack>
        <Stack gap="var(--spacing-3xs)">
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.budget}
              onChange={(event) => onChange({ budget: event.target.checked })}
            />
            <Typography variant="body-sm" as="span">
              {t('telegramCard.advanced.budget')}
            </Typography>
          </label>
          <Typography variant="caption" color="subtle" data-telegram-budget-hint>
            {t('telegramCard.advanced.budgetHint')}
          </Typography>
        </Stack>
        <TextField
          label={t('telegramCard.advanced.token')}
          type="password"
          value={token}
          onChange={onToken}
          placeholder={t('telegramAnswers.tokenPlaceholder')}
          {...(maskedToken
            ? { hint: t('telegramCard.setup.tokenSaved', { mask: maskedToken }) }
            : {})}
          isMono
        />
        {answersToken ? (
          <TextField
            label={t('telegramAnswers.token')}
            type="password"
            value={answersToken.value}
            onChange={answersToken.onChange}
            placeholder={t('telegramAnswers.tokenPlaceholder')}
            hint={
              answersToken.masked
                ? `${t('telegramAnswers.tokenSaved', { mask: answersToken.masked })} · ${t('telegramAnswers.tokenHint')}`
                : t('telegramAnswers.tokenHint')
            }
            isMono
          />
        ) : null}
        <Stack direction="row" gap="var(--spacing-xs)" wrap align="center">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="refresh" size={18} />}
            onClick={onCheck}
            isLoading={checking}
          >
            {t('telegramCard.advanced.checkNow')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onRestart} isLoading={restarting}>
            {t('telegramCard.advanced.restart')}
          </Button>
          {maskedToken ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={18} />}
              onClick={onForget}
            >
              {t('telegramCard.advanced.forget')}
            </Button>
          ) : null}
        </Stack>
        {checkDetail ? (
          <Typography variant="caption" color="subtle">
            {checkDetail}
          </Typography>
        ) : null}
        {lastSend ? <TelegramLastSendLine lastSend={lastSend} /> : null}
        {answersState ? (
          <Typography variant="caption" color="subtle" data-telegram-answers-state>
            {answersState}
          </Typography>
        ) : null}
      </Stack>
    </details>
  );
}
