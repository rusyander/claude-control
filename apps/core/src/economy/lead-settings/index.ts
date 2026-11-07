/**
 * Действующие настройки ведущего — одна функция на ядро и панель: тело живёт в контрактах
 * (`contracts/core/lead-resolve`), экран запуска показывает ровно то, по чему решает ядро.
 */
export {
  resolveLeadSettings,
  type EffectiveLeadSettings,
  type LeadSettingsInput,
  type LeadSource,
  type LeadWarning,
} from '@agentdeck/contracts/core/lead-resolve';
