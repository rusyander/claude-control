import { useState } from 'react';
import { Stack } from '@shared/ui/stack';
import { Icon } from '@shared/ui/icon';
import type { NewNodeInputProps } from './NewNodeInput.types';
import styles from './ResourceFileTree.module.scss';

/**
 * Поле имени прямо в дереве — как в редакторах кода. Enter создаёт, Escape
 * отменяет; отдельного окна ради одного имени не нужно.
 */
export function NewNodeInput({ placeholder, onSubmit, onCancel }: NewNodeInputProps) {
  const [name, setName] = useState('');

  return (
    <Stack
      direction="row"
      align="center"
      gap="var(--spacing-2xs)"
      padding="var(--spacing-3xs) var(--spacing-2xs)"
    >
      <Icon name="file" size={16} />
      <input
        className={styles.newNodeInput}
        value={name}
        placeholder={placeholder}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && name.trim()) onSubmit(name.trim());
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={() => !name.trim() && onCancel()}
      />
    </Stack>
  );
}
