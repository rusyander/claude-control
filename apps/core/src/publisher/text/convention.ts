import type { CommitConvention, PublishTextConfig } from '@agentdeck/contracts/core/publish';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { join } from 'node:path';
import { readTextFact } from '../../platform/safe-io/files.ts';
import { isLetter } from './scan.ts';

/**
 * Соглашение о сообщениях коммитов, найденное по истории репозитория (05:42): conventional commits
 * или нет, язык, доля подписанных DCO. Публикатор держит авторские коммиты, только когда каждое
 * сообщение проходит и сит, и это соглашение.
 */

const TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'tests',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
]);

/** Доля сообщений, с которой форма — соглашение репозитория. */
const MAJORITY = 0.5;

/** `type(scope)!: тема` — тип из списка, область без перевода строки, двоеточие и пробел. */
export function isConventional(message: string): boolean {
  const subject = message.split('\n')[0] ?? '';
  let i = 0;
  while (i < subject.length && subject[i]! >= 'a' && subject[i]! <= 'z') i += 1;
  if (!TYPES.has(subject.slice(0, i))) return false;
  if (subject[i] === '(') {
    const close = subject.indexOf(')', i);
    if (close === -1 || close === i + 1) return false;
    i = close + 1;
  }
  if (subject[i] === '!') i += 1;
  return subject[i] === ':' && subject[i + 1] === ' ' && subject.length > i + 2;
}

const isCyrillic = (c: string): boolean => c >= 'Ѐ' && c <= 'ӿ';

/** Язык темы: кириллица — больше трети букв → `ru`; идентификаторы в теме латиницей не перевешивают. */
export function languageOf(message: string): string {
  const subject = message.split('\n')[0] ?? '';
  let cyr = 0;
  let letters = 0;
  for (const c of subject) {
    if (!isLetter(c)) continue;
    letters += 1;
    if (isCyrillic(c)) cyr += 1;
  }
  if (letters === 0) return '';
  return cyr * 3 > letters ? 'ru' : 'en';
}

const signedOff = (message: string): boolean =>
  message.split('\n').some((line) => line.trim().toLowerCase().startsWith('signed-off-by:'));

/** Пустая история — соглашения нет: язык `''`, любой язык подходит, conventional не требуется. */
export function detectConvention(messages: readonly string[]): CommitConvention {
  if (messages.length === 0) return { conventional: false, language: '', signedOffShare: 0 };
  const share = (pick: (m: string) => boolean) => messages.filter(pick).length / messages.length;
  const languages = new Map<string, number>();
  for (const m of messages) {
    const lang = languageOf(m);
    if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }
  const language = [...languages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    conventional: share(isConventional) >= MAJORITY,
    language: language?.[0] ?? '',
    signedOffShare: share(signedOff),
  };
}

/** Сообщение в соглашении репозитория: форма conventional, когда она принята, и тот же язык. */
export function matchesConvention(message: string, convention: CommitConvention): boolean {
  if (convention.conventional && !isConventional(message)) return false;
  return convention.language === '' || languageOf(message) === convention.language;
}

const DEFAULT_CONFIG: PublishTextConfig = { companyNames: [], requireSignOff: false };

/** Разбор `<coreHome>/publish-text.json` (G9): чужие поля и не-строки отбрасываются. */
export function parsePublishTextConfig(raw: unknown): PublishTextConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_CONFIG;
  const obj = raw as { companyNames?: unknown; requireSignOff?: unknown };
  const names = Array.isArray(obj.companyNames) ? obj.companyNames : [];
  return {
    companyNames: names.filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
    requireSignOff: obj.requireSignOff === true,
  };
}

/**
 * Настройка сита из дома ядра. Нет файла — пустой список и без подписи (G9). Файл не прочитан или
 * не JSON — `unknown`: имена компаний неизвестны, и публикатор не выпускает текст вслепую.
 */
export async function loadPublishTextConfig(coreHome: string): Promise<Fact<PublishTextConfig>> {
  const fact = await readTextFact(join(coreHome, 'publish-text.json'));
  if ('absent' in fact) return { value: DEFAULT_CONFIG };
  if ('unknown' in fact) return fact;
  try {
    return { value: parsePublishTextConfig(JSON.parse(fact.value)) };
  } catch {
    return { unknown: 'publish-text.json is not JSON' };
  }
}
