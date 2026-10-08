import type { RuleRowProps } from '../ProjectLocalConfigView/ProjectLocalConfigView.types';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import styles from './RuleRow.module.scss';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';

/**
 * Файл правил из `.claude/rules`: заголовок, путь, маски `paths` и тело по
 * кнопке. Тело свёрнуто по умолчанию: правил бывает десяток, и развёрнутые
 * разом они превращают вкладку в один длинный документ.
 */
export function RuleRow({ rule }: RuleRowProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const toggleLabel = isOpen ? t('projectLocal.hideBody') : t('projectLocal.showBody');

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-2xs)" minWidth={0}>
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Stack gap="var(--spacing-2xs)" minWidth={0} flex={1}>
            <Typography variant="body-sm" weight="medium" as="span">
              {rule.title}
            </Typography>
            <Typography variant="mono" color="subtle" as="span" truncate>
              {rule.path}
            </Typography>
          </Stack>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={isOpen}
            aria-label={`${toggleLabel}: ${rule.title}`}
            rightIcon={
              <Icon
                name="chevronDown"
                size={16}
                className={isOpen ? styles.chevronOpen : styles.chevron}
              />
            }
            onClick={() => setIsOpen((value) => !value)}
          >
            {toggleLabel}
          </Button>
        </Stack>
        {rule.paths.length > 0 && (
          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-2xs)"
            wrap
            title={t('projectLocal.pathsHint')}
          >
            {rule.paths.map((mask) => (
              <Badge key={mask} tone="neutral">
                {mask}
              </Badge>
            ))}
          </Stack>
        )}
        {isOpen && <pre className={styles.body}>{rule.body}</pre>}
      </Stack>
    </li>
  );
}
