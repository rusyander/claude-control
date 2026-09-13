import { useTranslation } from 'react-i18next';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { usePlatformRunPlan } from '@entities/Platform';
import {
  MODEL_OPTIONS,
  EFFORT_LEVELS,
  modelLabel,
  modelSelectOptions,
  platformLayersCaption,
  platformModelCaption,
  platformRefusalCaption,
  withCurrentValue,
} from '@shared/lib/chat-model';
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
  models,
  consumer = 'chat',
  onModelChange,
  onEffortChange,
}: ChatModelPickerProps) {
  const { t } = useTranslation();
  // Чем прогон пойдёт НА САМОМ ДЕЛЕ (Т6). Через контур выбор человека — просьба,
  // а не решение: имя вендора контур не знает и получил бы 403, поэтому оно
  // переводится картой соответствия, а усилие не отправляется вовсе. Показать
  // выбранное как действующее значило бы соврать ровно в том месте, куда человек
  // смотрит перед отправкой сообщения. Считается ТОЙ ЖЕ функцией, что на
  // сервере, — второй расчёт разошёлся бы с первым молча.
  const plan = usePlatformRunPlan(consumer);
  const routed = plan.data?.routed === true ? plan.data : undefined;
  const caption = routed
    ? platformModelCaption(routed.title, chooseRunModel(routed.rules, model))
    : undefined;
  // Снятые нами слои (Т8) — здесь же и по той же причине: «агент не читает мои
  // правила» выглядит поломкой агента, пока человек не увидит, что это его
  // собственная галочка на карточке контура. Сказать надо ДО отправки
  // сообщения, а не объяснять постфактум.
  const layers = platformLayersCaption(routed?.layers);
  const refusal = platformRefusalCaption(plan.data);

  // Как подписать пункт «по умолчанию»: показываем, что именно придёт из настроек.
  const defaultModelName = defaultModel ? modelLabel(defaultModel) : t('chat.modelClaudeDefault');
  const defaultEffortName = defaultEffort
    ? t(`chat.effort_${defaultEffort}`)
    : t('chat.effortAuto');

  // Алиасы + конкретные модели каталога; выбранное значение остаётся в списке,
  // даже если каталог не скачался.
  const modelOptions = withCurrentValue(
    modelSelectOptions(models ?? [], MODEL_OPTIONS, (value) =>
      value ? modelLabel(value) : t('chat.fromSettings', { value: defaultModelName }),
    ),
    model,
  );

  return (
    // Подписи контура узкой колонкой под выбором: во всю ширину они растягивали
    // блок, и соседние кнопки шапки уезжали на отдельную строку.
    <Stack gap="var(--spacing-3xs)" className={styles.picker}>
      <Stack direction="row" align="center" gap="var(--spacing-3xs)">
        <select
          className={styles.select}
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          aria-label={t('chat.model')}
          title={t('chat.modelHint')}
        >
          {modelOptions.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
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

      {/* Подпись появляется ТОЛЬКО когда прогон идёт через контур: в обычном
          разговоре она была бы шумом, а здесь — единственное место, где видно,
          что выбранное имя по дороге заменят. Живой областью, потому что она
          меняется от выбора модели рядом: незрячий человек иначе узнавал бы о
          подмене ниоткуда. */}
      {caption && (
        <Typography
          variant="caption"
          color={caption.warn ? 'warning' : 'muted'}
          as="span"
          role="status"
          aria-live="polite"
        >
          {t(caption.key, caption.params)}
        </Typography>
      )}

      {refusal && (
        <Typography variant="caption" color="warning" as="span" role="status" aria-live="polite">
          {t(refusal.key, {
            title: refusal.params.title,
            reason: t(`chat.platformRefusedReason.${refusal.params.reason}`),
            fix: t(`chat.platformRefusedFix.${refusal.params.reason}`),
          })}
        </Typography>
      )}

      {layers && routed && (
        <Typography variant="caption" color="muted" as="span" role="status" aria-live="polite">
          {t(layers.key, {
            title: routed.title,
            // Разделитель — точка, а не запятая: в названии самого слоя запятые
            // уже есть («личные правила, хуки и права»), и перечисление через
            // запятую читалось бы как шесть слоёв вместо трёх.
            list: layers.dropped.map((id) => t(`platform.layerTitle.${id}`)).join(' · '),
          })}
        </Typography>
      )}

      {routed && !routed.effort && (
        <Typography variant="caption" color="muted" as="span">
          {t('chat.platformNoEffort', { title: routed.title })}
        </Typography>
      )}
    </Stack>
  );
}
