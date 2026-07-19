import { useTranslation } from 'react-i18next';
import { MODEL_OPTIONS, EFFORT_LEVELS, modelLabel } from '@shared/lib/chat-model';
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

interface ChatModelPickerProps {
  /** Оверрайд модели для этого чата ('' = брать из настроек). */
  model: string;
  /** Оверрайд глубины для этого чата ('' = брать из настроек). */
  effort: string;
  /** Модель по умолчанию из настроек — чтобы подписать пункт «по умолчанию». */
  defaultModel: string;
  /** Глубина по умолчанию из настроек. */
  defaultEffort: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}

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
    <div className={styles.picker}>
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
    </div>
  );
}
