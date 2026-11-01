import { PLATFORM_VENDOR_PREFIX } from '@agentdeck/contracts/platform-presets';
import { hopText } from '../texts.ts';
import { readSubstitutionMap, type HopDriver } from './driver.types.ts';

/**
 * Платформа компании — часть манифеста, которую спрашивает конвейер (перенос
 * `drivers/enterprise-platform.ts` панели без проб и матрицы возможностей). Знание о
 * платформе проверено в её исходниках панелью; здесь — то же знание, без пересказа.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Потолок ответа сервера контура: режет ЛЮБОЙ ответ, поток тоже. */
const PLATFORM_RESPONSE_CEILING_SEC = 120;

/** Драйвер по префиксу вендорных полей: слово в именах полей своё у каждой установки. */
export function buildEnterprisePlatformDriver(prefix: string = PLATFORM_VENDOR_PREFIX): HopDriver {
  const f = (name: string): string => `${prefix}_${name}`;
  return {
    id: 'enterprise-platform',
    title: 'Контур',
    cacheMarkModels: /^(?:anthropic\/)?claude-/i,
    requestFields: [
      {
        dialect: 'anthropic',
        field: 'tools',
        fate: 'dropped',
        note: 'свои инструменты контуру объявить нельзя: он подбирает их сам (`no-client-tools`)',
      },
      {
        dialect: 'anthropic',
        field: 'tool_choice',
        fate: 'dropped',
        note: 'выбирать не из чего: набор инструментов не наш',
      },
      {
        dialect: 'anthropic',
        field: 'thinking',
        fate: 'dropped',
        note: 'подписанный блок размышлений мост воспроизвести не может — подпись стала бы недействительной',
      },
      {
        dialect: 'openai',
        field: 'tools',
        fate: 'dropped',
        note: 'контур игнорирует схемы инструментов молча: он подбирает инструменты сам (`no-client-tools`)',
      },
      {
        dialect: 'openai',
        field: 'tool_choice',
        fate: 'dropped',
        note: 'у контура имеет смысл только «none»: набор инструментов не наш',
      },
      {
        dialect: 'openai',
        field: 'n',
        fate: 'dropped',
        note: 'принято схемой и потеряно: контур отдаёт один вариант ответа (справочник §5)',
      },
      {
        dialect: 'openai',
        field: 'presence_penalty',
        fate: 'dropped',
        note: 'принято схемой контура и до модели не доносится',
      },
      {
        dialect: 'openai',
        field: 'frequency_penalty',
        fate: 'dropped',
        note: 'принято схемой контура и до модели не доносится',
      },
      {
        dialect: 'openai',
        field: 'user',
        fate: 'dropped',
        note: 'принято схемой контура и до модели не доносится',
      },
      {
        dialect: 'openai',
        field: 'reasoning_effort',
        fate: 'dropped',
        note: 'схемой контура не объявлено: усилие рассуждения до модели не доходит (Т12)',
      },
      {
        dialect: 'openai',
        field: 'response_format',
        fate: 'dropped',
        note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
      },
      {
        dialect: 'openai',
        field: 'seed',
        fate: 'dropped',
        note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
      },
      {
        dialect: 'openai',
        field: 'logprobs',
        fate: 'dropped',
        note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
      },
      {
        dialect: 'openai',
        field: 'logit_bias',
        fate: 'dropped',
        note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
      },
    ],

    readFrame(payload) {
      if (payload[f('status')] !== undefined) {
        return { kind: 'status', field: f('status'), stage: String(payload[f('status')]) };
      }
      if (payload[f('reasoning')] !== undefined) {
        return { kind: 'reasoning', field: f('reasoning') };
      }
      if (payload[f('sanitized')] !== undefined) {
        // Перечень лежит внутри кадра или рядом с ним: читаются оба уровня.
        const nested = payload[f('sanitized')];
        return {
          kind: 'sanitized',
          field: f('sanitized'),
          verdict: isRecord(nested) ? nested : payload,
        };
      }
      if (payload[f('guardrails')] !== undefined) {
        const nested = payload[f('guardrails')];
        const verdict = isRecord(nested) ? nested : payload;
        return {
          kind: 'guardrails',
          field: f('guardrails'),
          verdict: Array.isArray(nested) ? { violations: nested } : verdict,
          // Флаг остановки на двух уровнях: потерять его — оборванный ответ сочтут целым.
          interrupted: verdict.stream_interrupted === true || payload.stream_interrupted === true,
        };
      }
      if (payload[f('tools_unavailable')] !== undefined) {
        return { kind: 'tools-dropped', field: f('tools_unavailable') };
      }
      const replaced = payload[f('deanonymized')];
      if (replaced !== undefined) {
        return {
          kind: 'replacement',
          field: f('deanonymized'),
          text: typeof replaced === 'string' ? replaced : '',
        };
      }
      if (payload[f('deanonymized_entities')] !== undefined) {
        return {
          kind: 'anonymization',
          field: f('deanonymized_entities'),
          mapping: readSubstitutionMap(payload[f('deanonymized_entities')]),
        };
      }
      if (payload[f('anonymization_mapping')] !== undefined) {
        return {
          kind: 'anonymization',
          field: f('anonymization_mapping'),
          mapping: readSubstitutionMap(payload[f('anonymization_mapping')]),
        };
      }
      return undefined;
    },

    placeholderPattern: /\[\p{L}[\p{L}\d_]*_\d+\]/u,
    vendorFields: [f('guardrails'), f('sanitized'), f('status'), f('tools_unavailable')],
    // `message` нарушения не читается никогда: в тексте сканера бывает найденное.
    violationNames: [
      { field: 'rule_name', label: true },
      { field: 'rule_type' },
      { field: 'scanner_name' },
    ],
    budgetRefusals: [{ message: /^budget exceeded for this API key$/i, scope: 'key' }],
    statusRows: [
      {
        upstream: 401,
        status: 401,
        code: 'authentication_error',
        message: hopText('gateway-key-rejected'),
      },
      { upstream: 402, status: 402, code: 'billing_error', message: hopText('gateway-key-budget') },
      {
        upstream: 451,
        status: 400,
        code: 'content_policy_violation',
        message: hopText('gateway-content-checks-request'),
        violations: true,
      },
      {
        upstream: 503,
        status: 503,
        code: 'overloaded_error',
        message: hopText('gateway-registry-not-ready'),
      },
    ],
    nonStreamTimeoutSec: PLATFORM_RESPONSE_CEILING_SEC,
    responseCeilingSec: PLATFORM_RESPONSE_CEILING_SEC,
    clientTools: 'shim',
    shimRequestFields: { tool_choice: 'none' },
  };
}

export const enterprisePlatformDriver = buildEnterprisePlatformDriver();
