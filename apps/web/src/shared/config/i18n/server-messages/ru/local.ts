import type { LocalMessageCode } from '@agentdeck/contracts/server-messages';

export const localRu: Record<LocalMessageCode, string> = {
  'local-port-busy': 'порт {{port}} занят другим сервером — остановите его или освободите порт',
  'local-start-failed': 'не удалось запустить {{binary}}',
  'local-exited': 'сервер моделей завершился сразу после запуска (код {{code}}) — журнал: {{log}}',
  'local-timeout': 'сервер моделей не ответил за {{seconds}} с — журнал: {{log}}',
  'local-stop-failed': 'сервер на порту {{port}} не остановился',
  'local-release-http': 'GitHub ответил {{status}} на запрос выпуска Ollama',
  'local-asset-missing': 'в выпуске Ollama {{version}} нет файла {{name}}',
  'local-sums-missing': 'в выпуске Ollama {{version}} нет sha256sum.txt',
  'local-download-http': 'загрузка не удалась: HTTP {{status}}',
  'local-download-cut':
    'загрузка оборвалась: {{done}} из {{size}} байт — нажмите ещё раз, докачается',
  'local-download-cancelled': 'загрузка отменена',
  'local-checksum-missing': 'для {{name}} нет контрольной суммы в выпуске',
  'local-checksum-mismatch': 'контрольная сумма {{name}} не сошлась — файл удалён, нажмите ещё раз',
  'local-binary-missing': 'в распакованном архиве нет исполняемого файла ollama',
  'local-runtime-missing': 'сервер моделей не установлен — сначала «Установить»',
  'local-server-down': 'сервер моделей не запущен',
  'local-model-unknown': 'модели {{tag}} нет в каталоге панели',
  'local-model-missing': 'модель {{tag}} не скачана',
  'local-contour-save': 'сохранение контура: {{reason}}',
  'local-contour-activate': 'включение контура: {{reason}}',
  'local-contour-deactivate': 'выключение контура: {{reason}}',
  'local-npm-failed': 'установка Qwen Code не удалась: {{reason}}',
  'local-kit-provider': 'набор панели для {{provider}} не поддерживается',
  'local-import-failed': 'не удалось забрать {{tag}} из системного Ollama: {{reason}}',
  'local-job-unknown': 'такой загрузки нет',
  'kit-item-unknown': 'В наборе панели нет такого элемента',
  'kit-mode-unsupported': 'Этот CLI такой режим набора не поддерживает',
  'kit-global-missing': 'В глобальном слое нет такого элемента',
  'kit-global-unsupported':
    'В глобальный слой и обратно переносятся только навыки, команды и субагенты',
  'kit-hooks-invalid': 'hooks.json не сохранён: это не JSON вида {"hooks": {…}}',
  'kit-compose-failed':
    'Прогон не запущен: набор панели не собрался. Переключите режим набора на «Только ваши» или повторите',
  'kit-codex-too-large':
    'Прогон не запущен: правила и навыки набора панели для Codex — {{size}} знаков, а командная строка Codex вмещает не больше {{limit}}. Ничего не обрезано: выключите часть элементов набора или переключите режим набора на «Только ваши»',
};
