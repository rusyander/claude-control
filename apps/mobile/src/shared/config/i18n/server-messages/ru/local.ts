import type { LocalMessageCode } from '@agentdeck/contracts/server-messages';

export const localRu: Record<LocalMessageCode, string> = {
  'local-supervisor-gave-up':
    'сервер упал и не поднялся после {{restarts}} попыток подряд; панель пробует снова раз в 10 минут',
  'local-port-busy': 'порт {{port}} занят другим сервером — остановите его или освободите порт',
  'local-start-failed': 'не удалось запустить {{binary}}',
  'local-exited': 'сервер моделей завершился сразу после запуска (код {{code}}) — журнал: {{log}}',
  'local-timeout': 'сервер моделей не ответил за {{seconds}} с — журнал: {{log}}',
  'local-stop-failed': 'сервер на порту {{port}} не остановился',
  'local-download-http': 'загрузка не удалась: HTTP {{status}}',
  'local-download-cut':
    'загрузка оборвалась: {{done}} из {{size}} байт — нажмите ещё раз, докачается',
  'local-download-cancelled': 'загрузка отменена',
  'local-checksum-mismatch': 'контрольная сумма {{name}} не сошлась — файл удалён, нажмите ещё раз',
  'local-runtime-missing': 'сервер моделей не установлен — сначала «Установить»',
  'local-server-down': 'сервер моделей не запущен',
  'local-model-unknown': 'модели {{tag}} нет в каталоге панели',
  'local-model-missing': 'модель {{tag}} не скачана',
  'local-contour-save': 'сохранение контура: {{reason}}',
  'local-contour-activate': 'включение контура: {{reason}}',
  'local-contour-deactivate': 'выключение контура: {{reason}}',
  'local-npm-failed': 'установка Qwen Code не удалась: {{reason}}',
  'local-kit-provider': 'набор панели для {{provider}} не поддерживается',
  'local-release-http': 'GitHub ответил {{status}} на запрос выпуска llama.cpp',
  'local-asset-missing': 'в {{version}} нет файла {{name}}',
  'local-sums-missing': '{{version}}: у файла в выпуске нет контрольной суммы',
  'local-checksum-missing': 'для {{name}} нет контрольной суммы',
  'local-binary-missing': 'в распакованном архиве нет исполняемого файла llama-server',
  'local-import-failed': 'не удалось забрать {{tag}} из хранилища Ollama: {{reason}}',
  'local-load-failed': 'llama.cpp не открыл модель {{tag}}: {{reason}} — скачайте её заново',
  'local-quant-unknown': 'у модели {{tag}} нет квантования {{quant}}',
  'local-context-range': 'окно контекста должно быть от {{min}} до {{max}} токенов',
  'local-choice-no-fit':
    'у {{tag}} это сочетание не влезает: нужно {{need}} ГБ, доступно {{available}} ГБ',
  'local-custom-input':
    'назовите репозиторий как «владелец/репозиторий» или ссылкой на Hugging Face',
  'local-custom-no-gguf': 'в репозитории {{repo}} нет файлов GGUF с готовым квантованием',
  'local-custom-no-arch':
    'не удалось прочитать устройство модели из {{repo}}: без слоёв и голов внимания память под окно не посчитать',
  'local-job-unknown': 'такой загрузки нет',
  'local-mcp-project': 'нужен абсолютный путь к каталогу проекта',
  'local-claude-settings-broken':
    'settings.json Claude не читается как JSON — исправьте файл: {{path}}',
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
