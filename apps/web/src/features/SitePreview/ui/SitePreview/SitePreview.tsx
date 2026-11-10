import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PICK_MODE_TYPE } from '@agentdeck/contracts/site-preview';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { acceptPick, isPickCancel } from '../../lib/acceptPick';
import type { SitePreviewProps } from './SitePreview.types';
import styles from './SitePreview.module.scss';

/**
 * Окно сайта проекта в чате (этап 12, D20). Сайт идёт через прокси панели в iframe; «Выбрать
 * элемент» включает в нём подсветку, щелчок шлёт описание элемента сюда. Принимается только
 * сообщение этого iframe с адреса прокси и со своим `nonce` — остальное не читается вовсе.
 * Выбор снимается сам после одного элемента, по Escape (в сайте или здесь) и повторным нажатием.
 */
export function SitePreviewPane({ preview, onPick, onClose, name, siteUrl }: SitePreviewProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameFocused, setFrameFocused] = useState(false);
  const label = name ?? t('sitePreview.title');

  // Режим выбора — скрипту окна, только на адрес прокси: чужая страница его не получит.
  const sendMode = useCallback(
    (on: boolean) => {
      const target = frameRef.current?.contentWindow;
      if (!target) return;
      target.postMessage(
        { type: PICK_MODE_TYPE, nonce: preview.nonce, on },
        new URL(preview.url).origin,
      );
    },
    [preview.nonce, preview.url],
  );

  useEffect(() => sendMode(picking), [picking, sendMode]);
  useEffect(() => setPicking(false), [preview.siteId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current?.contentWindow ?? null;
      const pick = acceptPick(event, frame, preview);
      if (pick) {
        setPicking(false);
        onPick(pick);
        return;
      }
      if (isPickCancel(event, frame, preview)) setPicking(false);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview, onPick]);

  // Фокус ушёл в сайт (Tab или щелчок): сайт с другого адреса, и `:focus` у рамки браузер не
  // ставит — окно панели только теряет фокус, а активным остаётся iframe. Кольцо рисует класс.
  useEffect(() => {
    const sync = (): void => setFrameFocused(document.activeElement === frameRef.current);
    const onBlur = (): void => {
      sync();
      // Если activeElement ещё не переключился на iframe к blur окна — сверка следующим тиком.
      window.setTimeout(sync, 0);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', sync);
    document.addEventListener('focusin', sync);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', sync);
      document.removeEventListener('focusin', sync);
    };
  }, []);

  // Escape, когда фокус у панели, а не в сайте: тот же выход из выбора.
  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  return (
    <Stack className={styles.panel} data-site-preview="">
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-sm)"
        className={styles.header}
      >
        <Stack gap="var(--spacing-3xs)" className={styles.heading}>
          <Typography variant="body-sm" weight="medium" as="span">
            {label}
          </Typography>
          <Typography variant="caption" color="subtle" as="span" className={styles.address}>
            {siteUrl || t('sitePreview.title')}
          </Typography>
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Button
            size="sm"
            variant={picking ? 'primary' : 'secondary'}
            aria-pressed={picking}
            title={t('sitePreview.pickHint')}
            onClick={() => setPicking((on) => !on)}
          >
            {/* Имя кнопки-переключателя постоянно: состояние несёт aria-pressed и вид. */}
            {t('sitePreview.pick')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="refresh" size={24} />}
            aria-label={t('sitePreview.reload')}
            onClick={() => {
              setPicking(false);
              setFrameKey((key) => key + 1);
            }}
          />
          {siteUrl && (
            <a
              className={styles.external}
              href={siteUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t('sitePreview.openInBrowser')}
              title={t('sitePreview.openInBrowser')}
            >
              <Icon name="link" size={20} />
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={24} />}
            aria-label={t('sitePreview.close')}
            onClick={onClose}
          />
        </Stack>
      </Stack>

      {picking && (
        <Typography variant="caption" color="subtle" as="p" className={styles.hint} role="status">
          {t('sitePreview.pickHint')}
        </Typography>
      )}

      <div className={`${styles.body} ${picking ? styles.bodyPicking : ''}`}>
        <iframe
          key={frameKey}
          ref={frameRef}
          className={`${styles.frame} ${frameFocused ? styles.frameFocused : ''}`}
          src={preview.url}
          title={t('sitePreview.frameTitle', { name: label })}
          // Сайт свой, но не панель: формы и скрипты — да, верх окна панели — нет.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          // Страница перезагрузилась (HMR, переход) — скрипт выбора новый: режим ему заново.
          onLoad={() => sendMode(picking)}
        />
      </div>
    </Stack>
  );
}
