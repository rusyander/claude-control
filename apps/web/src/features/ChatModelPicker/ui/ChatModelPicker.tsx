import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { MODEL_OPTIONS, EFFORT_LEVELS, modelLabel } from '@shared/lib/chat-model';
import type { ChatModelPickerProps } from './ChatModelPicker.types';
import styles from './ChatModelPicker.module.scss';

/**
 * Выбор модели и глубины продумывания для ТЕКУЩЕГО чата. Пустое значение —
 * «как в настройках» (глобальный дефолт). Выбор конкретного значения — локальный
 * оверрайд этого чата, глобальные настройки он не меняет. Значения хранит
 * страница чата (per-chat), сюда приходят готовыми пропсами.
 *
 * Намеренно нативные select: компактно в шапке, правильно работают с клавиатурой
 * и экранными дикторами, и их не нужно чинить при обновлении браузера.
 */

export function ChatModelPicker({
  model,
  effort,
  defaultModel,
  defaultEffort,
  onModelChange,
  onEffortChange,
}: ChatModelPickerProps) {
  const { t } = useTranslation();

  // Как подписать пункт «по умолчанию»: показываем, что именно придёт из настроек.
  const defaultModelName = defaultModel ? modelLabel(defaultModel) : t('chat.modelClaudeDefault');
  const defaultEffortName = defaultEffort
    ? t(`chat.effort_${defaultEffort}`)
    : t('chat.effortAuto');

  return (
    <Stack direction="row" align="center" gap="var(--spacing-3xs)">
      <select
        className={styles.select}
        value={model}
        onChange={(event) => onModelChange(event.target.value)}
        aria-label={t('chat.model')}
        title={t('chat.modelHint')}
      >
        {MODEL_OPTIONS.map((value) => (
          <option key={value || 'default'} value={value}>
            {value ? modelLabel(value) : t('chat.fromSettings', { value: defaultModelName })}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={effort}
        onChange={(event) => onEffortChange(event.target.value)}
        aria-label={t('chat.effort')}
        title={t('chat.effortHint')}
      >
        {EFFORT_LEVELS.map((level) => (
          <option key={level || 'default'} value={level}>
            {level
              ? t(`chat.effort_${level}`)
              : t('chat.fromSettings', { value: defaultEffortName })}
          </option>
        ))}
      </select>
    </Stack>
  );
}
