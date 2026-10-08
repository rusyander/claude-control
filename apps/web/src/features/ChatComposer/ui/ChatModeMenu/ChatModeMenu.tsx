import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import type { ChatModeMenuProps, ComposerMode } from '../ChatComposer/ChatComposer.types';

import styles from './ChatModeMenu.module.scss';
import { MODE_ICON } from './ChatModeMenu.constants';

export function ChatModeMenu({ state, disabled }: ChatModeMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (mode: ComposerMode): void => {
    state.onModeChange(mode);
    close();
  };

  const title = t(`chat.mode.${state.mode}`);

  return (
    <div
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        leftIcon={<Icon name={MODE_ICON[state.mode]} size={20} />}
        onClick={() => {
          // Перечитать план ровно на открытии: в обновлении состояния этого
          // делать нельзя — React зовёт его дважды и запрос ушёл бы парой.
          if (!isOpen) state.onMenuOpen?.();
          setOpen(!isOpen);
        }}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        disabled={disabled}
        title={t('chat.mode.hint')}
      >
        {title}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('chat.mode.title')}>
            <button
              type="button"
              className={styles.item}
              aria-current={state.mode === 'text'}
              onClick={() => pick('text')}
            >
              <Icon name="chat" size={20} />
              <span className={styles.itemText}>
                <Typography variant="body-sm" as="span">
                  {t('chat.mode.text')}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('chat.mode.textHint')}
                </Typography>
              </span>
            </button>

            <button
              type="button"
              className={styles.item}
              aria-current={state.mode === 'image'}
              disabled={!state.imageAvailable}
              onClick={() => pick('image')}
              title={state.imageAvailable ? undefined : state.imageReason}
            >
              <Icon name="image" size={20} />
              <span className={styles.itemText}>
                <Typography variant="body-sm" as="span">
                  {t('chat.mode.image')}
                </Typography>
                {/* Причина недоступности — на виду, а не в подсказке мыши: на
                    телефоне подсказки нет вовсе, а решение «чинить контур или
                    вписать адрес эндпоинта» человек принимает именно по ней. */}
                <Typography
                  variant="caption"
                  color={state.imageAvailable ? 'subtle' : 'danger'}
                  as="span"
                >
                  {state.imageAvailable
                    ? (state.imageSource ?? t('chat.mode.imageHint'))
                    : (state.imageReason ?? t('chat.mode.imageBlocked'))}
                </Typography>
              </span>
            </button>

            <button
              type="button"
              className={styles.item}
              aria-current={state.mode === 'deck'}
              disabled={!state.deckAvailable}
              onClick={() => pick('deck')}
              title={state.deckAvailable ? undefined : state.deckReason}
            >
              <Icon name="overview" size={20} />
              <span className={styles.itemText}>
                <Typography variant="body-sm" as="span">
                  {t('chat.mode.deck')}
                </Typography>
                <Typography
                  variant="caption"
                  color={state.deckAvailable ? 'subtle' : 'danger'}
                  as="span"
                >
                  {state.deckAvailable
                    ? (state.deckSource ?? t('chat.mode.deckHint'))
                    : (state.deckReason ?? t('chat.mode.deckBlocked'))}
                </Typography>
              </span>
            </button>

            {/* Подпись обхода стоит в меню, а не под композером: она объясняет
                ровно это правило — режим доступен там, где возможность
                объявлена, и недоступность называется словами. Отдельной строкой,
                а не внутри пункта: знак — это кнопка, а кнопка внутри кнопки не
                открывается ни мышью, ни с клавиатуры. */}
            <Stack direction="row" align="center" gap="var(--spacing-3xs)" className={styles.note}>
              <Typography variant="caption" color="subtle" as="span">
                {t('chat.mode.note')}
              </Typography>
              <CompromiseMark id="media-by-capability" />
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}
