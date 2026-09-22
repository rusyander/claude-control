import { existsSync } from 'node:fs';
import type { AppSettings, Group } from '@agentdeck/contracts';
import {
  GATE_HOOK_TIMEOUT_SEC,
  gateCommandOf,
  installedGateScriptPath,
} from '../../prompt-gate.ts';
import { scenarioTriggerCommand, scenarioTriggerPath } from '../../group-scenario.ts';
import type { SupervisorHook } from './run.ts';

/**
 * СОБСТВЕННЫЕ ЗАПИСИ ПАНЕЛИ, которые отыгрываются вокруг чужого прогона (П6.2).
 *
 * Механизмы, которые до сих пор существовали только у Claude, потому что были
 * написаны его хуками: калитка запросов и триггер сценария группы. Ни тот, ни
 * другой в файлы чужого CLI НЕ записывается — иначе панель завела бы в чужом
 * конфиге скрытый хук, который переживёт её саму. Отыгрывает их надзиратель, и
 * уровень верности у них поэтому «эмуляцией»: работает при запуске через панель,
 * запущенный человеком из терминала CLI их не увидит.
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
  /** Каталог скиллов панели — рядом со скиллом сценария лежит его триггер. */
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

  for (const group of request.groups) {
    const command = scenarioTriggerCommand(request.skillsDir, group);
    // Та же проверка, что у калитки, и по той же причине: скилл сценария человек
    // мог удалить с диска руками, а `UserPromptSubmit` — событие блокирующее.
    // Хук, чей файл не найден, отдал бы код выхода 1, надзиратель прочитал бы
    // его как «решение неизвестно» — и КАЖДОЕ сообщение чужому CLI получило бы
    // отказ из-за одного пропавшего триггера.
    if (command && existsSync(scenarioTriggerPath(request.skillsDir, group))) {
      hooks.push({ event: 'UserPromptSubmit', command, owner: 'panel' });
    }
  }

  return hooks;
}
