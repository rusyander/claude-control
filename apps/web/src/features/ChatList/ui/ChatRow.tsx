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
}: ChatRowProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
      onClick={onSelect}
      title={chat.projectPath || chat.project}
    >
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          {/* Точка у разговора, а не только у проекта: агентов в проекте может
              быть несколько, и «кто-то ждёт ответа» без адреса бесполезно.
              Пульсирует — тот же язык, что и в пульте агентов. */}
          {status && (
            <StatusDot tone={statusTone(status)} pulse label={t(`workspace.status.${status}`)} />
          )}
          <Typography variant="body-sm" weight="medium" className={styles.title}>
            {chat.title}
          </Typography>
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
            {chat.isSandbox ? t('chat.sandboxLabel') : projectName(chat.projectPath, chat.project)}
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
