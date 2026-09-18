import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { WorktreeReadinessProps } from './WorktreeReadiness.types';
import styles from './WorktreeReadiness.module.scss';

/**
 * Полна ли копия — постоянная строка карточки, а не след последней кнопки.
 *
 * Отчёт зеркала — событие: он приходит после «Обновить локальный слой» и
 * умирает вместе с вкладкой. А отказывает запуску агента (422 `copy_not_ready`)
 * сервер по СВЕРКЕ, которую делает заново перед каждым прогоном. Без этой
 * строки человек узнавал бы о неполной копии только в момент отправки
 * сообщения — и не понимал бы, чего именно не хватает и куда нажимать.
 *
 * Запись доступа — второй вопрос, ответа на который в файлах копии нет вовсе:
 * доверие к каталогу и списки серверов `.mcp.json` Claude Code держит у себя, в
 * `.claude.json`, под ключом рабочего каталога. У свежей копии каталог новый, и
 * без записи агент в ней начинает с двух вопросов человеку — файлами это не
 * лечится в принципе. Третье состояние, «сверять не с чем», отделено от «нет»
 * намеренно: у оригинала записи может не быть вовсе, и тогда копии её взять
 * неоткуда — чинить тут нечего.
 */

/** Строка про дыру: файла нет, общий каталог не связан, записи доступа нет. */
const GAP_KEY = {
  file: 'git.worktrees.copyGapFile',
  link: 'git.worktrees.copyGapLink',
  access: 'git.worktrees.copyGapAccess',
} as const;

const ACCESS_KEY = {
  ok: 'git.worktrees.copyAccessOk',
  missing: 'git.worktrees.copyAccessMissing',
  unknown: 'git.worktrees.copyAccessUnknown',
} as const;

export function WorktreeReadiness({ state, disabled, onRepair }: WorktreeReadinessProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="2px" className={styles.card} aria-label={t('git.worktrees.copyStateTitle')}>
      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        <Badge tone={state.ready ? 'success' : 'danger'}>
          {t(state.ready ? 'git.worktrees.copyReady' : 'git.worktrees.copyNotReady')}
        </Badge>
        <Typography
          variant="caption"
          color={state.access === 'missing' ? 'warning' : 'subtle'}
          as="span"
        >
          {t(ACCESS_KEY[state.access])}
        </Typography>
      </Stack>

      {state.ready ? (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.copyReadyHint')}
        </Typography>
      ) : (
        <>
          <ul className={styles.gaps}>
            {state.gaps.map((gap) => (
              <li key={`${gap.kind}:${gap.path}`}>{t(GAP_KEY[gap.kind], { path: gap.path })}</li>
            ))}
          </ul>
          <Typography variant="caption" color="subtle">
            {t('git.worktrees.copyNotReadyHint')}
          </Typography>
          <Stack direction="row">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              leftIcon={<Icon name="refresh" size={16} />}
              onClick={onRepair}
            >
              {t('git.worktrees.copyRepair')}
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}
