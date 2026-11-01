import { HOP_TEXTS } from './texts.data.ts';

/**
 * Тексты звена ПО КОДУ (замена `lib/server-texts` панели, план §2 H «texts → hop codes»).
 * Причину звена CLI печатает как есть (переводчика между ними нет), поэтому текст собирается
 * строкой; код восстанавливается по строке (`hopCodeOf`) — для следа звена и для языка ответа.
 * Свои коды звена (`hop-*`) — те, которых у панели не было: исчерпание, непрозрачное тело,
 * незнакомая метка, ключ без значения.
 */

const OWN_TEXTS = {
  'hop-dlp-opaque': {
    ru: 'Тело запроса не разобрано защитой данных — звено его не пропускает: {{reason}}',
    en: 'The request body was not parsed by data protection — the hop does not pass it: {{reason}}',
  },
  'hop-exhausted': {
    ru: 'Маршрут {{route}} исчерпал лимит расхода; снять отметку может только человек',
    en: 'Route {{route}} exhausted its spending limit; only a human can clear the mark',
  },
  'hop-unknown-tag': {
    ru: 'Звено не знает этот сеанс: ключ-заглушка не зарегистрирован',
    en: 'The hop does not know this session: the placeholder key is not registered',
  },
  'hop-key-unresolved': {
    ru: 'Ключ маршрута {{route}} не прочитан: {{reason}}',
    en: 'The key of route {{route}} was not read: {{reason}}',
  },
  'hop-stalled': {
    ru: 'Модель молчит дольше {{seconds}} с после начала ответа — повторите позже',
    en: 'The model has been silent for more than {{seconds}} s after the answer began — retry later',
  },
  'hop-upstream-unreachable': {
    ru: 'Нет связи с моделью: {{reason}}',
    en: 'No connection to the model: {{reason}}',
  },
} as const;

const ALL = { ...HOP_TEXTS, ...OWN_TEXTS };

export type HopTextCode = keyof typeof ALL;
export type TextLanguage = 'ru' | 'en';
export type TextParams = Record<string, string | number>;

const PARAM = /\{\{\s*(\w+)\s*\}\}/g;

function fill(template: string, params: TextParams = {}): string {
  return template.replace(PARAM, (_, name: string) =>
    params[name] === undefined ? '' : String(params[name]),
  );
}

/** Текст по коду — русский, как у панели по умолчанию; язык ответа — `localizeText`. */
export function hopText(code: HopTextCode, params?: TextParams): string {
  return fill(ALL[code].ru, params);
}

interface Compiled {
  code: HopTextCode;
  names: string[];
  pattern: RegExp;
  weight: number;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Длиннее литерал — строже шаблон: пробуется первым (склейка `{{message}}: {{detail}}` — последней).
const COMPILED: Compiled[] = (Object.keys(ALL) as HopTextCode[])
  .map((code) => {
    const ru = ALL[code].ru;
    const names = [...ru.matchAll(PARAM)].map((match) => match[1] as string);
    const parts = ru.split(PARAM);
    const source = parts
      .map((part, index) => (index % 2 === 0 ? escape(part) : '([\\s\\S]+?)'))
      .join('');
    return {
      code,
      names,
      pattern: new RegExp(`^${source}$`),
      weight: ru.replace(PARAM, '').length,
    };
  })
  .sort((left, right) => right.weight - left.weight);

/** Код текста звена или `undefined` (чужой текст — ответ модели, причина ОС). */
export function hopCodeOf(value: string): HopTextCode | undefined {
  return COMPILED.find((entry) => entry.pattern.test(value))?.code;
}

/**
 * Текст на языке ответа. Русский — как собран; английский — тот же шаблон по коду, подстановки
 * переводятся вглубь (склейка несёт внутри другой текст звена). Чужой текст остаётся как есть.
 */
export function localizeText(value: string, language: TextLanguage, depth = 0): string {
  if (language === 'ru' || depth > 4) return value;
  for (const entry of COMPILED) {
    const match = entry.pattern.exec(value);
    if (!match) continue;
    const params: TextParams = {};
    entry.names.forEach((name, index) => {
      params[name] = localizeText(match[index + 1] ?? '', language, depth + 1);
    });
    return fill(ALL[entry.code].en, params);
  }
  return value;
}
