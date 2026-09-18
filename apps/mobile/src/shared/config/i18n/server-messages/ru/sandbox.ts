import type { SandboxMessageCode } from '@agentdeck/contracts/server-messages';

export const sandboxRu: Record<SandboxMessageCode, string> = {
  'sandbox-unspecified': 'Не указана песочница',
  'sandbox-not-built': 'Песочница ещё не собрана: дождитесь окончания сборки и повторите прогон.',
  'sandbox-hook-script-missing':
    'Скрипт этого хука не попал в песочницу — прогон отменён, чтобы не запустить настоящий файл. Соберите песочницу заново.',
  'sandbox-script-name-invalid': 'Недопустимое имя скрипта',
  'sandbox-script-missing':
    'Скрипт не попал в песочницу — прогон отменён, чтобы не запустить настоящий файл. Соберите песочницу заново.',
  'sandbox-ask-incomplete': 'Нужны песочница и текст вопроса',
  'sandbox-reaped-idle':
    'Песочница убрана по простою: копия доступа к аккаунту в ней не должна лежать часами. Откройте её заново — состав соберётся снова.',
  'sandbox-nothing-to-run': 'Нечего запускать: команда не найдена',
  'sandbox-ps1-needs-pwsh':
    'Скрипты .ps1 запускаются через PowerShell — вне Windows нужен pwsh (PowerShell Core). Установите его или перепишите хук на .sh либо .mjs.',
  'sandbox-hook-exit-2': 'Хук вышел с кодом 2',
  'sandbox-hook-no-decision': 'Хук завершился с кодом {{code}} и решения не вернул',
  'sandbox-hook-not-started': 'Хук не запустился',
  'sandbox-wipe-failed': 'Не удалось очистить прежнюю песочницу: {{reason}}',
  'sandbox-remove-failed':
    'Песочницу не удалось удалить ({{reason}}). В ней осталась копия доступа к аккаунту — удалите папку {{path}} вручную.',
};
