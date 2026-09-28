import { useTranslation } from 'react-i18next';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import type { MediaRequestTextProps } from './MediaRequestText.types';
import styles from './ChatMessages.module.scss';

/**
 * Реплика-просьба режима «Презентация» или «Картинка». Её собирает панель:
 * правила из каталога плюс слова человека. Целиком она читалась как простыня,
 * написанная человеком, поэтому сверху — только его слова, а правила свёрнуты:
 * агент получил их, и спрятать совсем значило бы скрыть, о чём его просили.
 */
export function MediaRequestText({ request, text }: MediaRequestTextProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.text} data-media-request={request.kind}>
      <p>
        <strong>{t(`chat.mode.request.${request.kind}`)}:</strong> {request.topic}
      </p>
      <details className={styles.thinking}>
        <summary>{t('chat.mode.request.rules')}</summary>
        {/* markdown-it с выключенным сырым html — как и у остального текста ленты. */}
        <div
          className={styles.thinkingBody}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      </details>
    </div>
  );
}
