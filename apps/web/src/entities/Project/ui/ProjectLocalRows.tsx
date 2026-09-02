import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { HookRowProps, RuleRowProps, SkillRowProps } from './ProjectLocalConfigView.types';
import styles from './ProjectLocalConfigView.module.scss';

/**
 * Строки набора «Из проекта». Ни одна не правит: у проектного набора нет ни
 * тумблеров, ни форм — файлы принадлежат гиту проекта, панель их показывает.
 */

/** Скилл проекта: имя, описание, число дополнительных файлов; выключенный помечен. */
export function SkillRow({ skill }: SkillRowProps) {
  const { t } = useTranslation();

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-2xs)" minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {skill.name}
          </Typography>
          {skill.files.length > 0 && (
            <Badge tone="neutral">{t('projectLocal.files', { count: skill.files.length })}</Badge>
          )}
          {!skill.isEnabled && <Badge tone="neutral">{t('projectLocal.skillDisabled')}</Badge>}
        </Stack>
        {skill.description && (
          <Typography variant="body-sm" color="muted" clamp={2} className={styles.text}>
            {skill.description}
          </Typography>
        )}
      </Stack>
    </li>
  );
}

/**
 * Хук проекта: событие, matcher, команда. Запись из `settings.local.json`
 * отмечена именем файла — Claude Code читает его наравне с общим, и не показать
 * такой хук значило бы врать о том, что действует. Битый путь к скрипту — предупреждение.
 */
export function HookRow({ hook }: HookRowProps) {
  const { t } = useTranslation();

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-2xs)" minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="semibold" color="accent" as="span">
            {hook.event}
          </Typography>
          {hook.matcher && <Badge tone="accent">{hook.matcher}</Badge>}
          {hook.source === 'settings-local' && (
            <span title={t('projectLocal.localSourceHint')}>
              <Badge tone="info">settings.local.json</Badge>
            </span>
          )}
          {hook.scriptExists === false && (
            <Badge tone="warning" withDot>
              {t('projectLocal.scriptMissing')}
            </Badge>
          )}
        </Stack>
        {hook.description && (
          <Typography variant="body-sm" color="muted" clamp={2} className={styles.text}>
            {hook.description}
          </Typography>
        )}
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Icon name="link" size={18} />
          <Typography variant="mono" color="subtle" as="span" truncate title={hook.command}>
            {hook.command}
          </Typography>
        </Stack>
      </Stack>
    </li>
  );
}

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
