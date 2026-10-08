import type { AppSettings, Group } from '@agentdeck/contracts';
import {
  GATE_HOOK_TIMEOUT_SEC,
  gateCommandOf,
  installedGateScriptPath,
} from '../../prompt-gate/prompt-gate.ts';
import type { SupervisorHook } from './run.ts';

/**
 * СОБСТВЕННЫЕ ЗАПИСИ ПАНЕЛИ, которые отыгрываются вокруг чужого прогона (П6.2).
 *
 * Механизм, который до сих пор существовал только у Claude, потому что был
 * написан его хуком: калитка запросов (триггера сценария группы больше нет —
 * «Порядок работы» переехал в «Путь»). В файлы чужого CLI она НЕ записывается —
 * иначе панель завела бы в чужом конфиге скрытый хук, который переживёт её саму.
 * Отыгрывает её надзиратель, и уровень верности поэтому «эмуляция»: работает
 * при запуске через панель, запущенный человеком из терминала CLI её не увидит.
 *
 * Правила и журнал при этом ОДНИ И ТЕ ЖЕ: калитка у чужого CLI — тот самый файл
 * скрипта, что стоит у Claude, с тем же `dlp-rules.json` и тем же
 * `dlp-journal.jsonl`. Второй калитки, «для чужих», не существует — она разошлась
 * бы с первой на первом же изменении правил.
 *
 * Чего здесь НЕТ и не будет: хуков, перенесённых в файлы самой цели. Их
 * отыгрывает цель, и владельца события решает `hookEventOwner` — панель в это не
 * вмешивается.
 */

export interface PanelHooksRequest {
  readonly settings: Pick<AppSettings, 'promptGate'>;
  /** Группы панели; берутся включённые — выключенная ничего не навязывает. */
  readonly groups: readonly Group[];
  /** Каталог скриптов хуков панели — в нём лежит файл калитки. */
  readonly hooksDir: string;
  /** Не читается: триггера сценария больше нет; поле ждёт уборки вместе с вызывающими. */
  readonly skillsDir: string;
}

/**
 * Что панель отыграет сама на прогоне чужого CLI.
 *
 * Существование файла проверяется здесь, а не подразумевается: тумблер калитки
 * включён, а скрипт человек удалил — надзиратель обязан не запускать команду,
 * которой нет. Иначе каждый запрос платил бы запуском оболочки ради `-1`, а
 * fail-closed на блокирующем событии остановил бы работу целиком.
 */
export function panelSupervisorHooks(request: PanelHooksRequest): readonly SupervisorHook[] {
  const hooks: SupervisorHook[] = [];

  if (request.settings.promptGate?.enabled) {
    const script = installedGateScriptPath(request.hooksDir);
    if (script) {
      hooks.push({
        event: 'UserPromptSubmit',
        command: gateCommandOf(script),
        owner: 'panel',
        timeoutMs: GATE_HOOK_TIMEOUT_SEC * 1000,
      });
    }
  }

  // Триггер сценария группы здесь больше не отыгрывается: «Порядок работы»
  // переехал в «Путь» и идёт ходами конвейера, а не подсказкой по регулярке
  // (`groups/path-migration.ts`). Поля `groups`/`skillsDir` запроса остаются
  // ради вызывающих, пока их не уберут вместе с этим надзирателем.
  return hooks;
}
