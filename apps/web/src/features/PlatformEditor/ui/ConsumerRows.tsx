import { useTranslation } from 'react-i18next';
import {
  PLATFORM_ASSISTANT_TARGET,
  PLATFORM_TERMINAL_CONSUMER,
  type CompromiseId,
  type PlatformApplyTarget,
  type PlatformConsumerOption,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { TruncatedText } from '@shared/ui/truncated-text';
import { applyTargetTitle } from '@entities/Platform';
import styles from './PlatformWizard.module.scss';

/*
 * Строки потребителя и цели применения. Вынесены из шага мастера, потому что
 * те же строки стоят на вкладке «Доступ разделов» раздела «Контур»: список,
 * показанный в двух местах двумя копиями разметки, разошёлся бы на первой правке.
 */

interface ConsumerRowProps {
  consumer: PlatformConsumerOption;
  checked: boolean;
  /** Подпись о том, чем дойдут инструменты прогона; нет — доходят полем. */
  toolMark: CompromiseId | null;
  /** Галочка снята, но файл этого CLI применён — и он сильнее (см. `fileWins`). */
  fileWins: boolean;
  onToggle: () => void;
}

/**
 * Строка потребителя. Недоступный — прочерк с ПРИЧИНОЙ, как и у целей: чужой
 * CLI, который держит адрес в своём файле, нельзя включить «только для чата», и
 * сказать это словом честнее, чем дать галочку, которая сделает больше
 * обещанного.
 */
export function ConsumerRow({ consumer, checked, toolMark, fileWins, onToggle }: ConsumerRowProps) {
  const { t } = useTranslation();
  // Имя собственное чужого CLI приходит с сервера; встроенных потребителей
  // называет клиент — сервер языка интерфейса не знает.
  const title = consumer.title || t(`platform.consumer.${consumer.id}`);

  if (consumer.reason) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap className={styles.row}>
        <Typography variant="body-sm" color="subtle" as="span">
          — {title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.consumerReason.${consumer.reason}`)}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.row}>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <Typography variant="body-sm" as="span">
          {title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.consumerScope.${consumer.scope}`)}
        </Typography>
        {/* Чем дойдут инструменты CLI — это про прогоны, а не про ассистента
            панели и не про запись в файлы. */}
        {consumer.scope === 'run' && toolMark && <CompromiseMark id={toolMark} />}
      </label>

      {consumer.id === PLATFORM_TERMINAL_CONSUMER && (
        <Typography variant="caption" color="muted">
          {t('platform.consumerTerminalHint')}
        </Typography>
      )}

      {fileWins && (
        <Typography variant="caption" color="warning">
          {t('platform.consumerFileWins')}
        </Typography>
      )}
    </Stack>
  );
}

interface TargetRowProps {
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
