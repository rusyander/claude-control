import type { ImageAttachButtonProps } from '../image-attach.types';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { AGENT_IMAGE_ACCEPT } from '@agentdeck/contracts/agent-images';
import styles from '../image-attach.module.scss';
import type { ChangeEvent } from 'react';

/**
 * Кнопка «Приложить картинку» и скрытое поле выбора файла за ней. `accept` —
 * из общего списка типов, который проверяет и сервер: своя строка здесь
 * разошлась бы с ним молча.
 */
export function ImageAttachButton({ attach, size = 'md', className }: ImageAttachButtonProps) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        iconOnly
        icon={<Icon name="image" size={size === 'sm' ? 18 : 24} />}
        aria-label={t('attach.button')}
        title={`${t('attach.button')}. ${t('attach.hint')}`}
        onClick={attach.openPicker}
        disabled={attach.disabled}
        className={className}
        data-image-attach-button
      />
      <input
        ref={attach.inputRef}
        type="file"
        multiple
        accept={AGENT_IMAGE_ACCEPT}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden
        data-image-attach-input
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.target.files ?? []);
          // Тот же файл второй раз подряд — снова событие: иначе после «убрать»
          // вернуть его кнопкой было бы нельзя.
          event.target.value = '';
          void attach.add(files);
        }}
      />
    </>
  );
}
