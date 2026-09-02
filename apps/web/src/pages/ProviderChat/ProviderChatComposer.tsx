import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ProviderChatComposerProps } from './ProviderChatComposer.types';
import styles from './ProviderChatPage.module.scss';

/** Поле ввода: Enter отправляет, Shift+Enter переносит строку — как в чате Claude. */
export function ProviderChatComposer({
  attachments,
  onAttach,
  onClearAttachments,
  onSend,
  isRunning,
  isBlocked,
}: ProviderChatComposerProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');

  const submit = (): void => {
    const text = input.trim();
    if (!text || isRunning || isBlocked) return;
    setInput('');
    onSend(text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter во время набора через IME лишь подтверждает кандидата — по нему
    // не отправляем, иначе уходит половина слова.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <>
      {attachments.length > 0 && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          wrap
          className={styles.attachments}
        >
          <Typography variant="caption" color="subtle">
            {t('providerChat.attached', { count: attachments.length })}
          </Typography>
          <Button size="sm" variant="ghost" onClick={onClearAttachments}>
            {t('providerChat.clearAttachments')}
          </Button>
        </Stack>
      )}

      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('providerChat.placeholder')}
          aria-label={t('providerChat.placeholder')}
          rows={2}
          disabled={isBlocked}
        />
        <Button
          variant="ghost"
          iconOnly
          icon={<Icon name="paperclip" size={18} />}
          aria-label={t('providerChat.attach')}
          onClick={onAttach}
          disabled={isBlocked}
        />
        <Button
          variant="primary"
          onClick={submit}
          disabled={!input.trim() || isRunning || isBlocked}
          leftIcon={<Icon name="send" size={18} />}
        >
          {t('providerChat.send')}
        </Button>
      </div>
    </>
  );
}
