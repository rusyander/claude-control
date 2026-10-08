import { useTranslation } from 'react-i18next';
import type { ChatGroupChoice } from '@agentdeck/contracts/chat-group-settings';
import { ChatGroupPicker } from '@features/ChatGroupPicker';
import { useChats } from '@entities/Chat';
import {
  ownSettings,
  useChatGroupSettings,
  useSetChatGroupSettings,
} from '@entities/ChatGroupSettings';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { groupScopePath } from '../lib/groupScopePath';
import type { ChatGroupSettingsMenuProps } from './ChatGroupSettingsMenu.types';
import styles from './ChatGroupSettingsMenu.module.scss';

/**
 * Группа и автономность ЭТОГО чата — секция меню шапки.
 *
 * Настройка чата, а не проекта: в одном проекте рядом идут ревью по одной
 * лестнице и правка по другой. Ребёнок разделения без своего берёт значения
 * родителя — секция так и говорит, «из родителя: …», а щелчок у ребёнка пишет
 * только его собственное поле: второе остаётся унаследованным.
 */
export function ChatGroupSettingsMenu({
  chatId,
  sessionId,
  projectPath,
}: ChatGroupSettingsMenuProps) {
  const { t } = useTranslation();
  const settings = useChatGroupSettings(chatId, sessionId);
  const save = useSetChatGroupSettings();
  const chats = useChats();
  const view = settings.data;

  const parentTitle = (() => {
    const parentId = view?.parentChatId;
    if (!parentId) return '';
    return chats.data?.find((chat) => chat.id === parentId)?.title ?? parentId;
  })();
  const fromParent = t('chat.groupSettings.fromParent', { title: parentTitle });

  // Проектная группа — только своего проекта: чужая в этом чате не действует.
  // Проект — основная копия: ребёнок разделения работает в git-копии.
  const scopePath = groupScopePath(chats.data, [chatId, sessionId], projectPath);

  const write = (patch: { groupChoice?: ChatGroupChoice; autonomous?: boolean }): void => {
    // Запись — полная замена своего у чата. Пока предыдущая в полёте, вид ещё
    // старый: собранная из него вторая запись откатила бы только что сделанное
    // (тумблер, затем сразу группа — тумблер вернулся бы назад).
    const pending = save.isPending && save.variables?.chatId === chatId;
    const base = pending ? save.variables.settings : ownSettings(view);
    save.mutate({
      chatId,
      ...(sessionId ? { sessionId } : {}),
      // У черновика транскрипта ещё нет — проект сервер знает только отсюда, и
      // без него закрепление неактивной стороны пары проходило бы (F-107).
      ...(scopePath ? { projectPath: scopePath } : {}),
      settings: { ...base, ...patch },
    });
  };
  const hasOwn = Boolean(view && view.parentChatId && Object.keys(ownSettings(view)).length > 0);
  const failed = settings.isError;
  // Вид не загрузился — значение неизвестно: включённая галочка утверждала бы
  // автономность, которой, может быть, нет.
  const autonomous = failed ? false : (view?.autonomous ?? true);

  return (
    <>
      <Typography
        variant="caption"
        color="subtle"
        as="span"
        className={styles.groupTitle}
        id="chat-menu-group"
      >
        {t('chat.groupSettings.title')}
      </Typography>

      {failed && (
        <Typography variant="caption" color="danger" as="p" className={styles.row} role="alert">
          {t('chat.groupSettings.loadFailed')}
        </Typography>
      )}

      {view && (
        <div className={styles.row}>
          <ChatGroupPicker
            view={view}
            scopePath={scopePath}
            onChange={(groupChoice) => write({ groupChoice })}
            hint={view.groupChoiceInherited ? fromParent : t('chat.groupSettings.groupHint')}
          />
        </div>
      )}

      <Stack as="label" direction="row" className={styles.ruleRow}>
        <Toggle
          size="sm"
          checked={autonomous}
          // Не гасим на время записи: погашенная кнопка теряет фокус, и Escape
          // уже не закрывает меню — клавиатура оказывается в начале страницы.
          disabled={!view}
          onCheckedChange={(next) => {
            if (!save.isPending) write({ autonomous: next });
          }}
          aria-label={t('chat.groupSettings.autonomous')}
        />
        <span className={styles.ruleText}>
          <Typography variant="body-sm" color={autonomous ? 'default' : 'subtle'} as="span">
            {t('chat.groupSettings.autonomous')}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {view?.autonomousInherited ? fromParent : t('chat.groupSettings.autonomousHint')}
          </Typography>
        </span>
      </Stack>

      {/* Своё у ребёнка снимается одним щелчком — снова как у родителя. */}
      {hasOwn && (
        <button
          type="button"
          className={styles.item}
          onClick={() => save.mutate({ chatId, ...(sessionId ? { sessionId } : {}), settings: {} })}
        >
          {t('chat.groupSettings.resetToParent')}
        </button>
      )}

      <div className={styles.divider} />
    </>
  );
}
