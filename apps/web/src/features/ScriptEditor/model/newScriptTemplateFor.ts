import type { Language } from '@shared/config/i18n';
import { NEW_SCRIPT_TEMPLATE_EN, GENERIC_SCRIPT_TEMPLATE_EN } from './ScriptTemplate.en';
import { NEW_SCRIPT_TEMPLATE, GENERIC_SCRIPT_TEMPLATE } from './ScriptTemplate.constants';

/** Каркас нового скрипта под активного провайдера и язык интерфейса. */
export function newScriptTemplateFor(hasHooks: boolean, language: Language = 'ru'): string {
  if (language === 'en') return hasHooks ? NEW_SCRIPT_TEMPLATE_EN : GENERIC_SCRIPT_TEMPLATE_EN;
  return hasHooks ? NEW_SCRIPT_TEMPLATE : GENERIC_SCRIPT_TEMPLATE;
}
