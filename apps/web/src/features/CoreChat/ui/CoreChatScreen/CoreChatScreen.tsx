import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { refusalLine } from '../../model/chatRefusal';
import { chatStatusKey } from '../../model/chatView';
import { useCoreChat } from '../../model/useCoreChat';
import { CoreChatThread } from '../CoreChatThread/CoreChatThread';
import type { CoreChatScreenProps } from './CoreChatScreen.types';
import styles from './CoreChatScreen.module.scss';

/**
 * Открытый чат ядра: лента сеанса, строка состояния и композер. Ход человека — `message-to-step`
 * (ядро доставит на границе хода, даже если модель ещё отвечает); «Закрыть» — `end-chat`.
 */
export function CoreChatScreen({ taskId }: CoreChatScreenProps) {
  const { t } = useTranslation();
  const chat = useCoreChat(taskId);
  const [text, setText] = useState('');
  const P = 'coreChat';

  const launchRefused = chat.launchRefusal !== null || chat.failedReason !== null;
  const statusKey = chatStatusKey({ ...chat, launchRefused });
  const status = {
    key: statusKey,
    text: t(`${P}.status.${statusKey}`, { status: chat.refusal }),
  };
  // Отказ запуска называется словами и кодом ядра: чат без CLI молча не открывается и на прежний
  // исполнитель панели не уходит.
  const refused = refusalLine(chat.launchRefusal, chat.failedReason);
  const refusedText = refused ? t(`${P}.launchRefused.${refused.key}`, refused.params) : null;

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    void chat.send(body);
  };

  return (
    <div className={styles.screen} data-core-chat-screen data-core-chat-task={taskId}>
      <CoreChatThread items={chat.items} pending={chat.pending} />
      <Typography variant="caption" color="muted" data-core-chat-status={status.key}>
        {status.text}
      </Typography>
      {refusedText && (
        <Typography color="danger" data-core-chat-launch-refused={refused?.key}>
          {refusedText}
        </Typography>
      )}
      {chat.error && (
        <Typography color="danger" data-core-chat-error-line>
          {chat.error}
        </Typography>
      )}
      {!chat.closed && !launchRefused && (
        <Stack gap="var(--spacing-xs)" data-core-chat-composer>
          <TextField
            label={t(`${P}.composer.label`)}
            value={text}
            onChange={setText}
            placeholder={t(`${P}.composer.placeholder`)}
            multiline
            rows={3}
            disabled={!chat.stepId}
          />
          <Stack direction="row" justify="between" align="center">
            <Button
              variant="ghost"
              onClick={() => void chat.end()}
              disabled={!chat.stepId}
              title={t(`${P}.composer.endHint`)}
              data-core-chat-end
            >
              {t(`${P}.composer.end`)}
            </Button>
            <Button onClick={send} disabled={!chat.stepId || !text.trim()} data-core-chat-send>
              {t(`${P}.composer.send`)}
            </Button>
          </Stack>
        </Stack>
      )}
    </div>
  );
}
