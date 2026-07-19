import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { useArtifactSource, artifactUrl } from '@entities/Chat/api/ChatApi';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { highlightCode } from '@shared/lib/markdown/highlightCode';
import { useTheme } from '@shared/hooks/use-theme';
import { toast } from '@shared/lib/toast';
import type { ArtifactPreviewProps } from './ArtifactPreview.types';
import styles from './ArtifactPreview.module.scss';

type Tab = 'preview' | 'source';

/**
 * Предпросмотр файла, созданного Claude. Страницу показываем как страницу,
 * разметку — как документ, а рядом даём вкладку с исходником: по коду видно,
 * что именно сгенерировано, и его можно скопировать.
 */
export function ArtifactPreview({ chatId, artifact, onClose }: ArtifactPreviewProps) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const [tab, setTab] = useState<Tab>('preview');

  const source = useArtifactSource(chatId, artifact.hasSource ? artifact.name : undefined);
  const [highlighted, setHighlighted] = useState('');

  useEffect(() => {
    setTab('preview');
  }, [artifact.name]);

  // Подсветка грузит грамматику языка, поэтому она асинхронная: до готовности
  // показывается обычный моноширинный текст.
  useEffect(() => {
    if (tab !== 'source' || !source.data) return;

    let isCurrent = true;
    void highlightCode(source.data, artifact.name, theme).then((html) => {
      if (isCurrent) setHighlighted(html);
    });

    return () => {
      isCurrent = false;
    };
  }, [tab, source.data, artifact.name, theme]);

  const documentHtml = useMemo(
    () => (artifact.kind === 'markdown' && source.data ? renderMarkdown(source.data) : ''),
    [artifact.kind, source.data],
  );

  const copy = (): void => {
    void navigator.clipboard.writeText(source.data ?? '').then(() => {
      toast.success(t('toasts.copied'));
    });
  };

  return (
    <Stack className={styles.panel}>
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-sm)"
        className={styles.header}
      >
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {artifact.name}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            <Badge tone="neutral">{t(`chat.kind.${artifact.kind}`)}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {formatSize(artifact.sizeBytes)}
            </Typography>
          </Stack>
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          {artifact.hasSource && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="copy" size={24} />}
              aria-label={t('chat.copyArtifact')}
              onClick={copy}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={24} />}
            aria-label={t('common.close')}
            onClick={onClose}
          />
        </Stack>
      </Stack>

      {artifact.hasSource && (
        <div className={styles.tabs}>
          <TabButton isActive={tab === 'preview'} onClick={() => setTab('preview')}>
            {t('chat.tabPreview')}
          </TabButton>
          <TabButton isActive={tab === 'source'} onClick={() => setTab('source')}>
            {t('chat.tabSource')}
          </TabButton>
        </div>
      )}

      <div className={styles.body}>
        {tab === 'source' ? (
          <div
            className={styles.source}
            // Разметку строит Shiki из текста файла: пользовательского ввода
            // в ней нет, а токены подсветки иначе не отрисовать.
            dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(source.data ?? '') }}
          />
        ) : (
          <PreviewBody chatId={chatId} artifact={artifact} documentHtml={documentHtml} />
        )}
      </div>
    </Stack>
  );
}

interface PreviewBodyProps {
  chatId: string;
  artifact: ArtifactPreviewProps['artifact'];
  documentHtml: string;
}

function PreviewBody({ chatId, artifact, documentHtml }: PreviewBodyProps) {
  const url = artifactUrl(chatId, artifact.name);

  if (artifact.kind === 'image') {
    return <img src={url} alt={artifact.name} className={styles.image} />;
  }

  if (artifact.kind === 'pdf' || artifact.kind === 'html') {
    return (
      <iframe
        // Страница сгенерирована моделью, поэтому идёт в песочницу: скрипты
        // внутри работают, но до самого приложения дотянуться не могут.
        sandbox="allow-scripts"
        src={artifact.kind === 'pdf' ? url : `${url}&as=html`}
        className={styles.frame}
        title={artifact.name}
      />
    );
  }

  if (artifact.kind === 'markdown') {
    // Разметку собирает markdown-it с выключенным html — сырых тегов из
    // ответа модели в неё не попадёт.
    return <div className={styles.document} dangerouslySetInnerHTML={{ __html: documentHtml }} />;
  }

  return <ArtifactPlainText chatId={chatId} name={artifact.name} />;
}

function ArtifactPlainText({ chatId, name }: { chatId: string; name: string }) {
  const source = useArtifactSource(chatId, name);
  return <div className={styles.source}>{source.data}</div>;
}

function TabButton({
  isActive,
  onClick,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char,
  );
}
