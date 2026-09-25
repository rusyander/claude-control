import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { statusTone } from '@shared/lib/agent-runs';
import { projectName } from '@entities/Project';
import { highlightSnippet } from '../model/highlight';
import { formatWhen } from '../lib/formatWhen';
import type { ChatRowProps } from './ChatList.types';
import styles from './ChatList.module.scss';

export function ChatRow({
  chat,
  isActive,
  language,
  onSelect,
  snippet,
  matchCount,
  query,
  status,
  depth,
}: ChatRowProps) {
  const { t } = useTranslation();

  // У чата из разделения имя проекта бесполезно — это копия того же
  // репозитория. Полезна ветка: по ней человек и узнаёт свою группу. Ветка
  // берётся из транскрипта, поэтому в списке она та, где агент СЕЙЧАС, — с
  // иконкой, иначе имя ветки читается как ещё одно название проекта.
  const subtitle = () => {
    if (chat.branch) {
      return (
        <>
          <Icon name="branch" size={12} /> {chat.branch}
        </>
      );
    }
    if (chat.isSandbox) return t('chat.sandboxLabel');
    return projectName(chat.projectPath, chat.project);
  };

  return (
    <button
      type="button"
      className={`${styles.item} ${isActive ? styles.itemActive : ''} ${depth ? styles.itemChild : ''}`}
      onClick={onSelect}
      title={chat.projectPath || chat.project}
    >
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          {/* Точка у разговора, а не только у проекта: агентов в проекте может
              быть несколько, и «кто-то ждёт ответа» без адреса бесполезно.
              Пульсирует — тот же язык, что и в пульте агентов. */}
          {status && (
            <StatusDot
              tone={statusTone(status)}
              // Молчащий не пульсирует: событий нет — и точка стоит ровно.
              pulse={status !== 'quiet'}
              label={t(`workspace.status.${status}`)}
            />
          )}
          <Typography variant="body-sm" weight="medium" className={styles.title}>
            {chat.title}
          </Typography>
          {/* Звено конвейера. У работы метки нет: она и так подразумевается, а
              подписать каждый второй чат «работа» значит спрятать те, ради
              которых метка и заведена. */}
          {(chat.stage === 'triage' ||
            chat.stage === 'plan' ||
            chat.stage === 'review' ||
            chat.stage === 'fix' ||
            chat.stage === 'deliver') && (
            <Typography variant="caption" color="subtle" as="span" className={styles.stage}>
              {t(`chat.cascade.stage.${chat.stage}`)}
            </Typography>
          )}
          {/* Дерево разговора стоит на паузе: в списке иначе остановленный
              ребёнок неотличим от просто молчащего. */}
          {chat.paused && (
            <Typography variant="caption" color="subtle" as="span" className={styles.stage}>
              {t('chat.cascade.tree.paused')}
            </Typography>
          )}
          {/* Ждёт человека и принятая группа — те же слова, что в сводке хаба:
              иначе в списке их не отличить от просто молчащих чатов. */}
          {chat.awaitsYou && (
            <Typography variant="caption" color="warning" as="span" className={styles.stage}>
              {t('chat.cascade.tree.awaitsYou')}
            </Typography>
          )}
          {chat.accepted && (
            <Typography variant="caption" color="success" as="span" className={styles.stage}>
              {t('chat.cascade.tree.accepted')}
            </Typography>
          )}
        </Stack>

        {snippet ? (
          <Typography variant="caption" color="subtle" className={styles.preview} as="div">
            {highlightSnippet(snippet, query ?? '').map((part, index) =>
              part.match ? (
                <mark key={index} className={styles.mark}>
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </Typography>
        ) : (
          <Typography variant="caption" color="subtle" className={styles.preview}>
            {subtitle()}
          </Typography>
        )}

        <Stack direction="row" align="center" gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {formatWhen(chat.updatedAt, language, t)}
          </Typography>
          <span className={styles.dot}>·</span>
          {/* Иконка снимает догадку: число рядом с ней читается как «сообщений». */}
          <Icon name="chat" size={14} />
          {/* «+» у длинного разговора: список читает большой транскрипт началом
              и хвостом, поэтому точного итога у него нет — и выдавать неполное
              число за итог нечестно. Пояснение — в подсказке. */}
          <Typography
            variant="caption"
            color="subtle"
            as="span"
            title={chat.messageCountPartial ? t('chat.messageCountPartial') : undefined}
          >
            {chat.messageCount}
            {chat.messageCountPartial ? '+' : ''}
          </Typography>
          {matchCount !== undefined && (
            <>
              <span className={styles.dot}>·</span>
              <Icon name="search" size={14} />
              <Typography variant="caption" color="subtle" as="span">
                {matchCount}
              </Typography>
            </>
          )}
        </Stack>
      </Stack>
    </button>
  );
}
