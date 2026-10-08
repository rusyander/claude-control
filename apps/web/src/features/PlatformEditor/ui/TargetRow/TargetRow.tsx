import type { PlatformApplyTarget, CompromiseId } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import styles from './TargetRow.module.scss';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { applyTargetTitle } from '@entities/Platform';
import { TruncatedText } from '@shared/ui/truncated-text';

export interface TargetRowProps {
  target: PlatformApplyTarget;
  checked: boolean;
  overwrite: boolean;
  /** Подпись о том, чем дойдут инструменты CLI; нет — доходят полем, подписывать нечего. */
  toolMark: CompromiseId | null;
  onToggle: () => void;
  onToggleOverwrite: () => void;
}

/**
 * Строка цели. У неподдержанной — прочерк с ПРИЧИНОЙ и подписью: «нельзя» без
 * объяснения выглядит недоделкой, а причины здесь четыре и они разные (файла
 * переменных нет, переменная не задокументирована, диалект шлюзу не по зубам,
 * шлюз не поднят).
 */
export function TargetRow({
  target,
  checked,
  overwrite,
  toolMark,
  onToggle,
  onToggleOverwrite,
}: TargetRowProps) {
  const { t } = useTranslation();
  const isAssistant = target.targetId === PLATFORM_ASSISTANT_TARGET;

  if (!target.supported) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap className={styles.row}>
        <Typography variant="body-sm" color="subtle" as="span">
          — {target.title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.targetReason.${target.reason ?? 'no_env_section'}`)}
        </Typography>
        <CompromiseMark id="cli-no-endpoint" />
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.row}>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <Typography variant="body-sm" as="span">
          {applyTargetTitle(target, t)}
        </Typography>
        {isAssistant ? (
          <Typography variant="caption" color="muted" as="span">
            {t('platform.targetRecommended')}
          </Typography>
        ) : (
          toolMark && <CompromiseMark id={toolMark} />
        )}
      </label>

      {target.filePath && <TruncatedText text={target.filePath} variant="caption" color="subtle" />}

      {checked &&
        target.plan.map((item) => (
          <Typography key={item.key} variant="caption" color="subtle" as="div">
            <code>{item.key}</code>
            {' = '}
            {item.value}
            {item.placeholder ? ` (${t('platform.planPlaceholder')})` : ''}
          </Typography>
        ))}

      {/* Занятое место не перебивается молча: пока человек не увидел, что там
          стоит, и не подтвердил — цель уйдёт в пропущенные с причиной. */}
      {checked && target.conflicts.length > 0 && (
        <Stack gap="var(--spacing-3xs)">
          {target.conflicts.map((conflict) => (
            <Typography key={conflict.key} variant="caption" color="warning" as="div">
              {t('platform.conflictLine', { key: conflict.key, current: conflict.current })}
            </Typography>
          ))}
          <label className={styles.check}>
            <input type="checkbox" checked={overwrite} onChange={onToggleOverwrite} />
            <Typography variant="caption" as="span">
              {t('platform.overwriteLabel')}
            </Typography>
          </label>
        </Stack>
      )}
    </Stack>
  );
}
