import type { WatchEntryClass, WatchSeverity, WatchVerdict } from '@agentdeck/contracts';
import type { WatchEvent } from './types.ts';

/**
 * Слова `WATCH-REPORT.md` на языке интерфейса панели (решение владельца 27.09):
 * отчёт читает тот же человек или агент, которому он поручит починку. Метки
 * `<!-- watch:… -->` и их атрибуты от языка не зависят — по ним отчёт и читается.
 */
export type ReportLanguage = 'ru' | 'en';

export function reportLanguage(language: string | undefined): ReportLanguage {
  return language === 'en' ? 'en' : 'ru';
}

export interface ReportTexts {
  title: string;
  intro: string[];
  verdict: Record<WatchVerdict, string>;
  shortVerdict: Record<WatchVerdict, string>;
  entryClass: Record<WatchEntryClass, string>;
  severity: Record<WatchSeverity, string>;
  kind: Record<WatchEvent['kind'], string>;
  source: Record<WatchEvent['source'], string>;
  evidence: string;
  stack: string;
  output: string;
  happened: string;
  rootCause: string;
  steps: string;
  fix: string;
  wrong: string;
  notChecked: string;
  noticedIn: (ref: string) => string;
  type: string;
  importance: string;
  status: string;
  location: string;
  request: string;
  duration: (seconds: string) => string;
  route: string;
  repeats: string;
  firstSeen: string;
  lastSeen: string;
  merged: string;
  fingerprint: string;
  index: string;
  indexHead: string;
  byCode: string;
  sections: (
    total: number,
    failures: number,
    counts: Record<WatchVerdict, number>,
    remarks: number,
  ) => string;
  cases: string;
  firstRecord: string;
  lastRecord: string;
}

const RU: ReportTexts = {
  title: '# Отчёт фонового наблюдателя панели',
  intro: [
    'Проблемы, которые панель увидела за собой, пока был включён фоновый наблюдатель, и итог',
    'сверки каждой с исходным кодом панели. Один раздел — одна причина: повторы считаются в',
    'нём же, а не новыми разделами.',
    '',
    '- **Сбой** — что-то сломалось на деле; **замечание** — дефект, который модель заметила в',
    '  коде рядом при сверке, без сбоя на деле.',
    '- **Статус:** «подтверждён в коде» — причина найдена в коде панели, место указано;',
    '  «в коде причины нет» — окружение или не воспроизводится; «неясно»; «проверяется» —',
    '  модель ещё не сверила.',
    '- Номер `WR-n` не меняется, пока раздел в отчёте: на него и ссылайтесь («исправлено WR-12»).',
    '- Улики — текст сбоя как был, секреты замаскированы. Текст вне меток `<!-- watch:… -->`',
    '  панель не трогает.',
  ],
  verdict: {
    confirmed: 'подтверждён в коде',
    'not-in-code': 'в коде причины нет (окружение или не воспроизводится)',
    unclear: 'неясно',
    pending: 'проверяется',
  },
  shortVerdict: {
    confirmed: 'подтверждён',
    'not-in-code': 'не в коде',
    unclear: 'неясно',
    pending: 'проверяется',
  },
  entryClass: { failure: 'сбой', remark: 'замечание' },
  severity: { critical: 'критическая', high: 'высокая', medium: 'средняя', low: 'низкая' },
  kind: {
    'http-5xx': 'ответ сервера 5xx',
    'http-4xx': 'ответ 4xx на запрос своего же интерфейса',
    'log-error': 'ошибка в журнале сервера',
    'log-warn': 'предупреждение в журнале сервера',
    'process-crash': 'необработанное исключение сервера',
    'spawn-failed': 'CLI не запустился',
    'cli-exit': 'CLI завершился с ошибкой',
    'slow-request': 'медленный ответ сервера',
    'window-error': 'ошибка на странице',
    'unhandled-rejection': 'необработанный отказ промиса на странице',
    'render-crash': 'падение отрисовки страницы',
    'api-failure': 'запрос страницы к API не удался',
    'console-error': 'ошибка в консоли страницы',
    'console-warn': 'предупреждение в консоли страницы',
    'contract-mismatch': 'ответ API не того вида',
    'stuck-loading': 'загрузка на странице зависла',
    remark: 'замечание по коду',
  },
  source: { server: 'сервер', client: 'страница', model: 'сверка с кодом' },
  evidence: 'Улики',
  stack: 'Стек:',
  output: 'Вывод CLI (stderr, конец):',
  happened: 'Что произошло',
  rootCause: 'Причина',
  steps: 'Как воспроизвести',
  fix: 'Как исправить',
  wrong: 'Что не так',
  notChecked: '_Модель ещё не сверила этот сбой с кодом._',
  noticedIn: (ref) => `_Замечено при сверке раздела ${ref}._`,
  type: 'Тип',
  importance: 'Важность',
  status: 'Статус',
  location: 'Место в коде',
  request: 'Запрос',
  duration: (seconds) => `Длительность (самая долгая):** ${seconds} с`,
  route: 'Раздел панели',
  repeats: 'Повторов',
  firstSeen: 'впервые',
  lastSeen: 'последний раз',
  merged: 'Влиты как та же причина',
  fingerprint: 'Отпечаток',
  index: 'Оглавление',
  indexHead: '| № | Тип | Важность | Статус | Повторов | Место | Суть |',
  byCode: 'по коду',
  sections: (total, failures, c, remarks) =>
    `Разделов:** ${total} — сбоев ${failures} (подтверждено ${c.confirmed}, не в коде ${c['not-in-code']}, неясно ${c.unclear}, проверяется ${c.pending}), замечаний ${remarks}`,
  cases: 'Случаев всего (с повторами)',
  firstRecord: 'Первая запись',
  lastRecord: 'последняя',
};

const EN: ReportTexts = {
  title: '# Panel background watcher report',
  intro: [
    'Problems the panel saw about itself while the background watcher was on, and the result of',
    'checking each against the panel source code. One section is one cause: repeats are counted',
    'inside it, not as new sections.',
    '',
    '- **Failure** — something actually broke; **remark** — a defect the model noticed in nearby',
    '  code while checking, with no failure seen.',
    '- **Status:** “confirmed in code” — the cause is in the panel code, location given;',
    '  “not in code” — environment or not reproducible; “unclear”; “checking” — the model has',
    '  not checked it yet.',
    '- The `WR-n` number does not change while the section is in the report: refer to it',
    '  (“fixed WR-12”).',
    '- Evidence is the failure text as it was, secrets masked. The panel never touches text',
    '  outside the `<!-- watch:… -->` marks.',
  ],
  verdict: {
    confirmed: 'confirmed in code',
    'not-in-code': 'not in code (environment or not reproducible)',
    unclear: 'unclear',
    pending: 'checking',
  },
  shortVerdict: {
    confirmed: 'confirmed',
    'not-in-code': 'not in code',
    unclear: 'unclear',
    pending: 'checking',
  },
  entryClass: { failure: 'failure', remark: 'remark' },
  severity: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' },
  kind: {
    'http-5xx': 'server 5xx response',
    'http-4xx': '4xx response to the panel’s own request',
    'log-error': 'error in the server log',
    'log-warn': 'warning in the server log',
    'process-crash': 'unhandled server exception',
    'spawn-failed': 'CLI did not start',
    'cli-exit': 'CLI exited with an error',
    'slow-request': 'slow server response',
    'window-error': 'page error',
    'unhandled-rejection': 'unhandled promise rejection on the page',
    'render-crash': 'page render crash',
    'api-failure': 'page request to the API failed',
    'console-error': 'error in the page console',
    'console-warn': 'warning in the page console',
    'contract-mismatch': 'API reply of the wrong shape',
    'stuck-loading': 'page loading stuck',
    remark: 'code remark',
  },
  source: { server: 'server', client: 'page', model: 'code check' },
  evidence: 'Evidence',
  stack: 'Stack:',
  output: 'CLI output (stderr, tail):',
  happened: 'What happened',
  rootCause: 'Cause',
  steps: 'How to reproduce',
  fix: 'How to fix',
  wrong: 'What is wrong',
  notChecked: '_The model has not checked this failure against the code yet._',
  noticedIn: (ref) => `_Noticed while checking section ${ref}._`,
  type: 'Type',
  importance: 'Severity',
  status: 'Status',
  location: 'Location in code',
  request: 'Request',
  duration: (seconds) => `Duration (longest):** ${seconds} s`,
  route: 'Panel section',
  repeats: 'Repeats',
  firstSeen: 'first',
  lastSeen: 'last',
  merged: 'Merged as the same cause',
  fingerprint: 'Fingerprint',
  index: 'Contents',
  indexHead: '| No. | Type | Severity | Status | Repeats | Location | Gist |',
  byCode: 'code',
  sections: (total, failures, c, remarks) =>
    `Sections:** ${total} — failures ${failures} (confirmed ${c.confirmed}, not in code ${c['not-in-code']}, unclear ${c.unclear}, checking ${c.pending}), remarks ${remarks}`,
  cases: 'Occurrences (with repeats)',
  firstRecord: 'First record',
  lastRecord: 'last',
};

export const REPORT_TEXTS: Record<ReportLanguage, ReportTexts> = { ru: RU, en: EN };

/** Подпись «Место в коде» на любом из языков: отчёт мог начаться на другом. */
export const LOCATION_LINE = /^- \*\*(?:Место в коде|Location in code):\*\* `(.+)`$/m;
