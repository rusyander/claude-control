import { useTranslation } from 'react-i18next';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { ChatGroupPicker } from '@features/ChatGroupPicker';
import {
  ownSettings,
  useChatGroupSettings,
  useSetChatGroupSettings,
} from '@entities/ChatGroupSettings';
import { Typography } from '@shared/ui/typography';
import type { ProviderChatGroupPickerProps } from './ProviderChatGroupPicker.types';
import styles from './ProviderChatGroupPicker.module.scss';

/**
 * Группа разговора чужого CLI. Выбор пишется под ключом разговора
 * (`<cli>:<id>`) — тем же, по которому сервер собирает слой прогона
 * (`effectiveGroupsForRun`): раньше выбрать группу можно было только запросом
 * к API, и слой из выбранной группы человек в панели не видел вовсе.
 */
export function ProviderChatGroupPicker({
  providerId,
  chatId,
  workdir,
}: ProviderChatGroupPickerProps) {
  const { t } = useTranslation();
  const key = foreignChatKey(providerId, chatId);
  const settings = useChatGroupSettings(key);
  const save = useSetChatGroupSettings();
  const view = settings.data;

  return (
    <div className={styles.row} data-testid="provider-chat-group">
      {settings.isError && (
        <Typography variant="caption" color="danger" as="p" role="alert">
          {t('chat.groupSettings.loadFailed')}
        </Typography>
      )}
      {view && (
        <ChatGroupPicker
          view={view}
          scopePath={workdir}
          hint={t('providerChat.groupHint')}
          onChange={(groupChoice) =>
            save.mutate({
              chatId: key,
              ...(workdir ? { projectPath: workdir } : {}),
              settings: { ...ownSettings(view), groupChoice },
            })
          }
        />
      )}
    </div>
  );
}
