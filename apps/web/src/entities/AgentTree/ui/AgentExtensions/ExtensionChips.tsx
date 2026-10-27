import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { cn } from '@shared/lib/cn';
import { extensionChips } from '../../model/extensions';
import type { ExtensionChip } from '../../model/extensions.types';
import type { ExtensionChipsProps } from './AgentExtensions.types';
import styles from './AgentExtensions.module.scss';

const TONE: Record<ExtensionChip['kind'], BadgeTone> = {
  skill: 'accent',
  mcp: 'info',
  hook: 'neutral',
  denied: 'danger',
};

/**
 * Значки скиллов, хуков и MCP агента одной строкой: скиллы по именам, MCP по
 * серверам, хуки числом и отказы хуков отдельно. С `onOpen` строка — кнопка
 * окна «Скиллы, хуки и MCP» этого агента.
 */
export function ExtensionChips({ summary, onOpen, openLabel, className }: ExtensionChipsProps) {
  const { t } = useTranslation();
  const chips = extensionChips(summary);
  if (chips.length === 0) return null;

  const text = (chip: ExtensionChip): string => {
    if (chip.more) return t('agentTree.extensions.chipMore', { count: chip.count });
    if (chip.kind === 'hook') return t('agentTree.extensions.chipHooks', { count: chip.count });
    if (chip.kind === 'denied') return t('agentTree.extensions.chipDenied', { count: chip.count });
    return chip.count > 1 ? `${chip.label} ×${chip.count}` : chip.label;
  };
  const hint = (chip: ExtensionChip): string | undefined =>
    chip.more
      ? undefined
      : t(`agentTree.extensions.chipHint.${chip.kind}`, { name: chip.label, count: chip.count });

  const body = chips.map((chip, index) => (
    <span
      key={`${chip.kind}-${chip.label}-${index}`}
      title={hint(chip)}
      data-extension-chip={chip.kind}
    >
      <Badge tone={TONE[chip.kind]}>{text(chip)}</Badge>
    </span>
  ));

  if (!onOpen) {
    return (
      <span className={cn(styles.chips, className)} data-agent-extensions>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(styles.chips, styles.chipsButton, className)}
      title={t('agentTree.extensions.openHint')}
      aria-label={openLabel ?? t('agentTree.extensions.open')}
      data-agent-extensions
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {body}
    </button>
  );
}
