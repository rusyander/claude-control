import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComposerMode, ComposerModesProps } from './ComposerModes.types';
import styles from './ComposerModes.module.scss';

export const COMPOSER_MODES: readonly ComposerMode[] = ['describe', 'pick', 'hook'];

export function composerPanelId(idBase: string): string {
  return `${idBase}-panel`;
}

export function composerTabId(idBase: string, mode: ComposerMode): string {
  return `${idBase}-tab-${mode}`;
}

/**
 * Три способа добавить шаг: описать словами (ассистент найдёт готовое или
 * напишет новое), выбрать готовый из каталога, собрать хук. Настоящий
 * tablist: одна остановка Tab, стрелки ходят по способам.
 */
export function ComposerModes({ mode, idBase, onChange }: ComposerModesProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<ComposerMode, HTMLButtonElement>());

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = COMPOSER_MODES.indexOf(mode);
    let next: ComposerMode | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      next = COMPOSER_MODES[(index + delta + COMPOSER_MODES.length) % COMPOSER_MODES.length];
    } else if (event.key === 'Home') next = COMPOSER_MODES[0];
    else if (event.key === 'End') next = COMPOSER_MODES[COMPOSER_MODES.length - 1];
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t('groupBuilder.composer.modes')}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {COMPOSER_MODES.map((item) => (
        <button
          key={item}
          ref={(node) => {
            if (node) refs.current.set(item, node);
            else refs.current.delete(item);
          }}
          type="button"
          role="tab"
          id={composerTabId(idBase, item)}
          aria-selected={item === mode}
          aria-controls={composerPanelId(idBase)}
          tabIndex={item === mode ? 0 : -1}
          className={`${styles.tab} ${item === mode ? styles.tabActive : ''}`}
          onClick={() => onChange(item)}
        >
          {t(`groupBuilder.composer.${item}`)}
        </button>
      ))}
    </div>
  );
}
