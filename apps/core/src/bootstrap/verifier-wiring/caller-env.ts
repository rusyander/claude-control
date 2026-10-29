import type { CheckRequest } from '@agentdeck/contracts/core/records';

/**
 * Окружение ключа прогона (04:91, 03:124). Ядро гоняет под своим пином — ключ от пина. Вызывающий
 * (`exec: 'caller'`, дороги захвата) гоняет под СВОИМ окружением: поверх пина ложатся значения имён,
 * которые прокладка видела у себя (`null` — не задана, имя уходит). Иначе сессия с `CI=1`
 * повторяла бы запись, снятую без него. Фильтр `envAllow` один — в `verifier/key`; здесь только чьё
 * значение. Значения живут в памяти вызова, в ключ идёт ключевой хеш.
 */
export function keyEnv(
  pin: Readonly<Record<string, string>>,
  req: Pick<CheckRequest, 'exec' | 'callerEnv'>,
): Record<string, string> {
  if (req.exec !== 'caller' || !req.callerEnv) return { ...pin };
  const out: Record<string, string> = { ...pin };
  for (const [name, value] of Object.entries(req.callerEnv)) {
    // Без учёта регистра, как `envPart` ключа: `Path` пина и `PATH` вызывающего — одна переменная
    // Windows; оставь обе — ключ вызывающего нёс бы и чужое значение ядра.
    const upper = name.toUpperCase();
    for (const own of Object.keys(out)) if (own.toUpperCase() === upper) delete out[own];
    if (value !== null) out[name] = value;
  }
  return out;
}
