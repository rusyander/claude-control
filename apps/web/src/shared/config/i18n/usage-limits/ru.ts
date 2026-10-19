/**
 * Лимиты подписки Claude в боковой панели: сессия (5 часов), неделя и неделя
 * модели. Отдельный модуль, как у соседей: `ru.ts` общий, его правят несколько
 * задач разом. Подключён в `../ru.ts` ключом `usageLimits`.
 */
export const usageLimitsRu = {
  title: 'Лимиты подписки',
  session: 'Сессия (5 ч)',
  weekly: 'Неделя',
  weeklyModel: 'Неделя · {{model}}',
  reset: 'сброс {{time}}',
  resetUnknown: 'сброс не назван',
  aria: '{{label}}: использовано {{percent}}, {{reset}}',
  tooltipUsed: '{{label}}: использовано {{percent}}',
  tooltipReset: 'Сброс: {{time}} (через {{until}})',
  tooltipObserved: 'Данные на {{time}} — {{source}}',
  source: {
    oauth: 'ответ сервера Anthropic, обновляется раз в минуту',
    'chat-run': 'последний замер из прогона чата',
  },
  stale: 'устарело',
  status: {
    ok: '',
    'no-credentials': 'Нет входа Claude Code на этой машине',
    'api-key': 'Claude Code работает по ключу API — лимитов подписки нет',
    'token-expired': 'Вход Claude Code истёк — обновится при следующем запуске claude',
    unauthorized: 'Сервер Anthropic отказал токену Claude Code',
    'rate-limited': 'Сервер Anthropic просит подождать — повтор позже',
    unavailable: 'Нет ответа сервера Anthropic',
  },
  until: {
    days: '{{d}} д {{h}} ч',
    hours: '{{h}} ч {{m}} мин',
    minutes: '{{m}} мин',
    soon: 'меньше минуты',
  },
};
