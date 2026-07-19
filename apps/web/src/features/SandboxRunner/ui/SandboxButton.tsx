import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SandboxModal } from './SandboxModal';
import type { SandboxModalProps } from './SandboxModal.types';

type SandboxButtonProps = Omit<SandboxModalProps, 'isOpen' | 'onOpenChange'> & {
  size?: 'sm' | 'md';
};

/**
 * Кнопка «проверить в песочнице». Стоит рядом с каждым элементом настроек,
 * поэтому оформлена так же, как правка и удаление, — иконкой в один ряд.
 */
export function SandboxButton({ size = 'sm', ...props }: SandboxButtonProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        size={size}
        variant="ghost"
        iconOnly
        icon={<Icon name="sandbox" size={24} />}
        aria-label={`${t('sandbox.title')}: ${props.title}`}
        onClick={() => setIsOpen(true)}
      />

      {/* Песочница собирается при открытии и стирается при закрытии,
          поэтому монтируем окно только когда оно нужно. */}
      {isOpen && <SandboxModal {...props} isOpen={isOpen} onOpenChange={setIsOpen} />}
    </>
  );
}
