/**
 * Тексты справки вынесены из общего словаря: документов много, они длинные,
 * и в одном файле с подписями кнопок искать было бы нечего.
 *
 * Ключ на каждую строку, без массивов: строки достаются обычным t(), а
 * структура документа живёт в коде раздела — так видно, что где стоит.
 *
 * Этот файл — только сборка. Текст каждого раздела вместе с подписями его
 * снимков и схем лежит в `./ru/topics/<раздел>.ts`, и правится там: раздел
 * переписывают по одному, а в общий файл на семь тысяч строк двое пишущих
 * разом не помещаются. Английский устроен зеркально (`./en/topics/…`) и
 * типизирован по русскому — забыть ключ при переводе не даст сборка.
 */

import { chatRu } from './ru/topics/chat';
import { overviewRu } from './ru/topics/overview';
import { analyticsRu } from './ru/topics/analytics';
import { settingsRu } from './ru/topics/settings';
import { groupsRu } from './ru/topics/groups';
import { pluginsRu } from './ru/topics/plugins';
import { envRu } from './ru/topics/env';
import { mcpRu } from './ru/topics/mcp';
import { permissionsRu } from './ru/topics/permissions';
import { scriptsRu } from './ru/topics/scripts';
import { hooksRu } from './ru/topics/hooks';
import { skillsRu } from './ru/topics/skills';
import { commandsRu } from './ru/topics/commands';
import { rulesRu } from './ru/topics/rules';
import { claudeMdRu } from './ru/topics/claudeMd';
import { searchRu } from './ru/topics/search';
import { compareRu } from './ru/topics/compare';
import { historyRu } from './ru/topics/history';
import { testsRu } from './ru/topics/tests';
import { projectsRu } from './ru/topics/projects';
import { dlpRu } from './ru/topics/dlp';
import { panelAgentRu } from './ru/topics/panelAgent';
import { platformRu } from './ru/topics/platform';
import { endpointsRu } from './ru/topics/endpoints';
import { providersRu } from './ru/topics/providers';
import { integrationsRu } from './ru/topics/integrations';
import { promptsRu } from './ru/topics/prompts';
export const helpRu = {
  index: {
    subtitle: 'Как работает каждый раздел панели',
    lead:
      'У панели нет своей базы данных: всё, что вы здесь меняете, — это файлы ' +
      'конфигурации Claude Code на вашем диске. Поэтому в справке каждого ' +
      'раздела первым делом сказано, какой именно файл он правит и когда ' +
      'изменения дойдут до Claude.',

    howTitle: 'Как устроено приложение',
    howCaption:
      'Своей базы у панели нет — отсюда два следствия. Те же файлы можно ' +
      'править руками мимо панели, и почти любое изменение доходит до Claude ' +
      'только после перезапуска.',
    howPanel: 'Панель',
    howPanelCaption: 'формы, списки, помощник',
    howFiles: 'Файлы в ~/.claude',
    howFilesCaption: 'CLAUDE.md, settings.json, skills/…',
    howClaude: 'Claude Code',
    howClaudeCaption: 'читает их при старте сессии',
    howEdgeWrite: 'запись с резервной копией',
    howEdgeRestart: 'перезапуск',

    helpTitle: 'Как пользоваться самой справкой',
    helpButton: 'Кнопка «?» на странице',
    helpButtonText:
      'Рядом с заголовком каждого раздела стоит значок вопроса — он открывает ' +
      'разбор именно этого раздела. Вопрос обычно возникает на самой странице, а ' +
      'не в оглавлении.',
    helpLink: 'Ссылкой можно поделиться',
    helpLinkText:
      'Адрес документа содержит имя раздела, поэтому ссылку на нужное объяснение ' +
      'можно отправить коллеге или сохранить. Тем же способом устроены ссылки на ' +
      'конкретное правило, скилл или сервер внутри разделов.',
    helpNav: 'Переход к соседнему разделу',
    helpNavText:
      'Внизу документа — ссылки на предыдущий и следующий. Справку можно читать ' +
      'подряд, не возвращаясь в оглавление.',
    helpAssistant: 'Помощник почти в каждой форме',
    helpAssistantText:
      'Правила, скиллы, хуки, скрипты, серверы, права, переменные, группы и ' +
      'сценарии заполняются помощником: описываете задачу словами, он возвращает ' +
      'готовые поля. Работает по вашей подписке, отдельный ключ не нужен.',

    sectionsTitle: 'Разделы',
    sectionsCaption: 'Каждая карточка — подробный разбор своего раздела панели.',

    notFoundTitle: 'Такого раздела справки нет',
    notFoundText: 'Возможно, ссылка устарела. Откройте список разделов и выберите нужный.',
  },

  common: {
    back: 'Все разделы',
    openSection: 'Перейти в раздел',
    storageTitle: 'Где это лежит',
    fieldName: 'Поле',
    fieldPurpose: 'За что отвечает',
    required: 'обязательное',
    prevTopic: 'Предыдущий раздел',
    nextTopic: 'Следующий раздел',
    canTitle: 'Что здесь можно',
    cantTitle: 'Чего здесь нет',
    whyTitle: 'Зачем это нужно',
    howTitle: 'Как это работает',
    recipesTitle: 'Как сделать',
    assistantTitle: 'Помощник',
    notesTitle: 'Тонкости, о которые спотыкаются',
    onlyOnCreate: 'только при создании',
    readOnly: 'только чтение',
  },

  /**
   * Подписи снимков экрана. Ключ повторяет раскладку каталога
   * `apps/web/public/help/<раздел>/<сценарий>/<кадр>.png`, и она же проверяется
   * прогоном `node tools/qa/check-help-shots.mjs`: кадр без подписи и подпись
   * без кадра одинаково краснеют.
   *
   * Подпись служит и текстом `alt`: слепому читателю нужна та же фраза, что и
   * зрячему, а две формулировки разошлись бы в первый же месяц.
   */
  shots: {
    sidePlatform: 'Админка контура',
    sidePanel: 'Панель',
    chat: chatRu.shots,
    platform: platformRu.shots,
    tests: testsRu.shots,
    rules: rulesRu.shots,
    claudeMd: claudeMdRu.shots,
    projects: projectsRu.shots,
    groups: groupsRu.shots,
    permissions: permissionsRu.shots,
    mcp: mcpRu.shots,
    env: envRu.shots,
    skills: skillsRu.shots,
    commands: commandsRu.shots,
    hooks: hooksRu.shots,
    scripts: scriptsRu.shots,
    plugins: pluginsRu.shots,
    overview: overviewRu.shots,
    search: searchRu.shots,
    analytics: analyticsRu.shots,
    history: historyRu.shots,
    compare: compareRu.shots,
    settings: settingsRu.shots,
    providers: providersRu.shots,
    endpoints: endpointsRu.shots,
    integrations: integrationsRu.shots,
    prompts: promptsRu.shots,
    dlp: dlpRu.shots,
    panelAgent: panelAgentRu.shots,
  },

  /**
   * Подписи схем. Раскладка та же, что у снимков, только вместо сценария —
   * `diagrams`: `apps/web/public/help/<раздел>/diagrams/<имя>.png`. Исходник
   * каждой схемы — `.drawio` в `docs/diagrams/`, экспорт делает
   * `node tools/help-shots/diagrams.mjs`.
   */
  diagrams: {
    label: 'Схема',
    open: 'открыть в полный размер',
    chat: chatRu.diagrams,
    platform: platformRu.diagrams,
    tests: testsRu.diagrams,
    rules: rulesRu.diagrams,
    claudeMd: claudeMdRu.diagrams,
    projects: projectsRu.diagrams,
    groups: groupsRu.diagrams,
    permissions: permissionsRu.diagrams,
    mcp: mcpRu.diagrams,
    env: envRu.diagrams,
    skills: skillsRu.diagrams,
    commands: commandsRu.diagrams,
    hooks: hooksRu.diagrams,
    scripts: scriptsRu.diagrams,
    plugins: pluginsRu.diagrams,
    overview: overviewRu.diagrams,
    search: searchRu.diagrams,
    analytics: analyticsRu.diagrams,
    history: historyRu.diagrams,
    compare: compareRu.diagrams,
    settings: settingsRu.diagrams,
    providers: providersRu.diagrams,
    endpoints: endpointsRu.diagrams,
    integrations: integrationsRu.diagrams,
    dlp: dlpRu.diagrams,
    panelAgent: panelAgentRu.diagrams,
  },

  topics: {
    chat: chatRu.topic,
    overview: overviewRu.topic,
    analytics: analyticsRu.topic,
    settings: settingsRu.topic,
    groups: groupsRu.topic,
    plugins: pluginsRu.topic,
    env: envRu.topic,
    mcp: mcpRu.topic,
    permissions: permissionsRu.topic,
    scripts: scriptsRu.topic,
    hooks: hooksRu.topic,
    skills: skillsRu.topic,
    commands: commandsRu.topic,
    rules: rulesRu.topic,
    claudeMd: claudeMdRu.topic,
    search: searchRu.topic,
    compare: compareRu.topic,
    history: historyRu.topic,
    tests: testsRu.topic,
    projects: projectsRu.topic,
    dlp: dlpRu.topic,
    panelAgent: panelAgentRu.topic,
    platform: platformRu.topic,
    endpoints: endpointsRu.topic,
    providers: providersRu.topic,
    integrations: integrationsRu.topic,
    prompts: promptsRu.topic,
  },
};

export type HelpSchema = typeof helpRu;
