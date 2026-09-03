import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@claude-control/contracts';
import { HANDOFF_CONTEXT_LIMIT } from '@claude-control/contracts/chat-handoff';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import {
  MODEL_OPTIONS,
  EFFORT_LEVELS,
  modelLabel,
  modelSelectOptions,
  withCurrentValue,
} from '@shared/lib/chat-model';
import { useModelCatalog } from '@entities/ModelCatalog';
import { ModelCatalogCard } from './ModelCatalogCard';
import { EndpointCard } from './EndpointCard';
import { NumberSettingRow } from './NumberSettingRow';
import { SettingToggleRow } from './SettingToggleRow';
import type { SettingsTabProps } from './SettingsTabs.types';
import styles from './SettingsPage.module.scss';

/**
 * Раздел «Модели и подключения»: чем отвечает агент по умолчанию, откуда
 * берётся список моделей, куда уходит запрос и как панель проверяет
 * MCP-серверы. Всё это — одна цепочка «откуда приходит ответ».
 */
export function ModelsTab({ settings, patch }: SettingsTabProps) {
  const { t } = useTranslation();
  const { data: modelCatalog } = useModelCatalog();

  // Алиасы CLI плюс конкретные модели из каталога провайдера: зашитый список
  // устаревал молча, а каталог знает и о вышедших вчера.
  const modelOptions = withCurrentValue(
    modelSelectOptions(modelCatalog?.models ?? [], MODEL_OPTIONS, (value) =>
      value ? modelLabel(value) : t('settings.chatModelAuto'),
    ),
    settings.chatModel,
  );
  const effortOptions = EFFORT_LEVELS.map((level) => ({
    value: level,
    label: level ? t(`chat.effort_${level}`) : t('settings.chatEffortAuto'),
  }));
  // Порог — не свободное число, а выбор из немногих: полезных значений всего
  // несколько, а опечатка в поле («20000» вместо «200000») дала бы предложение
  // продолжить на каждом ходу. Ноль отдельным пунктом — это выключено, а не «0».
  const contextLimitLabel = (limit: number): string => {
    if (limit === 0) return t('settings.handoffContextLimitOff');
    const tokens = limit / 1000;
    return limit === HANDOFF_CONTEXT_LIMIT
      ? t('settings.handoffContextLimitDefault', { tokens })
      : t('settings.handoffContextLimitValue', { tokens });
  };
  const contextLimitOptions = [0, 150_000, HANDOFF_CONTEXT_LIMIT, 250_000].map((limit) => ({
    value: String(limit),
    label: contextLimitLabel(limit),
  }));

  return (
    <Stack gap="var(--spacing-lg)">
      {/* Модель и глубина по умолчанию для чата — централизованно здесь; в самом
          чате их можно переопределить локально для одного разговора. */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.chatDefaultsTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.chatDefaultsHint')}
          </Typography>

          <SelectField
            label={t('settings.chatModel')}
            value={settings.chatModel}
            onChange={(chatModel) => patch({ chatModel })}
            options={modelOptions}
            hint={t('settings.chatModelHint')}
          />
          <SelectField
            label={t('settings.chatEffort')}
            value={settings.chatEffort}
            onChange={(value) => patch({ chatEffort: value as AppSettings['chatEffort'] })}
            options={effortOptions}
            hint={t('settings.chatEffortHint')}
          />
          {/* Инициатива разделения задач по чатам. Тумблер здесь, а не в
              «безопасности»: это привычка агента в разговоре, а не право на
              запись. Кнопка «Разделить задачи» в поле ввода работает и при
              выключенном — просьбу всегда можно высказать вручную. */}
          <SettingToggleRow
            label={t('settings.taskSplitInitiative')}
            hint={t('settings.taskSplitInitiativeHint')}
            checked={settings.taskSplitInitiative}
            onChange={(taskSplitInitiative) => patch({ taskSplitInitiative })}
          />
          {/* Инициатива закрыть этап и продолжить в чистой сессии. Тумблер
              включает только ПРЕДЛОЖЕНИЕ: сам переход всё равно идёт по решению
              человека — кнопкой на карточке или автоматом, включённым в том
              конкретном разговоре. */}
          <SettingToggleRow
            label={t('settings.handoffInitiative')}
            hint={t('settings.handoffInitiativeHint')}
            checked={settings.handoffInitiative}
            onChange={(handoffInitiative) => patch({ handoffInitiative })}
          />
          {/* Второй повод продолжить — не смысл, а размер окна. Инициатива выше
              ждёт, пока агент СЧИТАЕТ задачу закрытой; порог смотрит на цену
              разговора, которая растёт и у незакрытой работы. Ничего не стирает:
              предохранители продолжения те же, а без включённого в разговоре
              автомата панель только предлагает. */}
          <SelectField
            label={t('settings.handoffContextLimit')}
            value={String(settings.handoffContextLimit)}
            onChange={(value) => patch({ handoffContextLimit: Number(value) })}
            options={contextLimitOptions}
            hint={t('settings.handoffContextLimitHint')}
          />
          {/* Значение тумблера на карточке для разговоров, где его не трогали.
              Отдельно от порога выше: порог решает, КОГДА зайдёт речь, а этот —
              спрашивать ли вообще. Тумблер конкретного разговора сильнее. */}
          <SettingToggleRow
            label={t('settings.handoffAutoDefault')}
            hint={t('settings.handoffAutoDefaultHint')}
            checked={settings.handoffAutoDefault}
            onChange={(handoffAutoDefault) => patch({ handoffAutoDefault })}
          />
        </Stack>
      </Card>

      {/* Каталог моделей провайдера: он же питает выпадающий список выше. */}
      <ModelCatalogCard />

      {/* Свой эндпоинт: адрес модели вместо облака вендора. Сразу за каталогом
          моделей — оба про то, откуда берутся ответы. */}
      <EndpointCard />

      {/* MCP: автопроверка связи при открытии раздела и потолок ожидания сети. */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.mcpTitle')}
          </Typography>

          <SettingToggleRow
            label={t('settings.mcpAutoCheck')}
            hint={t('settings.mcpAutoCheckHint')}
            checked={settings.mcpAutoCheck}
            onChange={(mcpAutoCheck) => patch({ mcpAutoCheck })}
          />
          <NumberSettingRow
            label={t('settings.mcpTimeout')}
            hint={t('settings.mcpTimeoutHint')}
            value={settings.mcpNetworkTimeoutMs}
            min={2000}
            max={120000}
            step={500}
            inputClassName={styles.numberInput}
            hintClassName={styles.hint}
            onChange={(mcpNetworkTimeoutMs) => patch({ mcpNetworkTimeoutMs })}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
