import type { ProcessRow } from '../../../lib/kill-tree.mjs';
import {
  automationOf,
  browserInstallOf,
  isBrowserChild,
  tempRoots,
} from '../../../lib/peer-process/browser-identity.ts';
import { ancestryOf } from '../../../lib/peer-process/peer-process.ts';
import { isRemoteProxy, type ProcessFacts } from '../../../lib/peer-process/process-facts.ts';
import { isAutomationBrowserName } from './throwaway-stand.ts';

/**
 * Кто на том конце соединения: человек, процесс модели — или «проверить не
 * удалось». Умолчание ПОСЛЕДНЕЕ: решение человека не принимается от того, кого
 * панель не узнала (D-S01, холодное ревью 23.10).
 *
 * Кому верим — ровно трём (RF-DS-05, повторное ревью 24.10):
 *   · вызову изнутри процесса панели (`app.inject` — сокета нет вовсе,
 *     `human-only.ts`): Telegram и агент панели со своим журналом возможностей;
 *   · браузеру человека (`browserWindow`): настоящая установка браузера, у
 *     корня браузера нет ключей автоматизации, прогона модели среди предков нет;
 *   · удалённому ответу через прокси Tailscale этой машины с ключом доступа.
 * Прежнее доверие «тому, кто запустил панель» снято: в этом проекте панель
 * перезапускает и сам агент, и отвязавшийся помощник, поднявший её, был бы
 * доверенным оракулом решений. Оно остаётся только на одноразовом стенде
 * проверки (`standTrusts`, `throwaway-stand.ts`) — там решать нечего настоящего.
 *
 * Прежнее правило окна (оболочка рабочего стола среди ЖИВЫХ предков) заперло
 * владельца: у долго работающего браузера родителя нет, и все 69 процессов
 * браузеров этой машины получали «не узнан» (RF-DS-04). Мёртвый родитель теперь
 * не отказ; отказ — прогон в цепочке, чужая программа и ключи автоматизации.
 *
 * Чего ворота не закрывают (RF-DS-08): они судят ПРОЦЕСС на сокете, а не руку
 * на кнопке. Правка фронта (`apps/web`, прокси Vite) — тоже путь решения: код,
 * дописанный в открытую у человека страницу, шлёт POST из настоящего окна, и
 * для ворот это человек. Так же — подменная программа под именем браузера,
 * запущенная с рабочего стола, и настоящее окно под CDP. Держит линию здесь не
 * эти ворота, а слой возможностей и запрет прогону решать собственный запрос;
 * закрыла бы подпись решения вне машины (вариант C отчёта).
 */

export interface GateFacts {
  table: readonly ProcessRow[];
  facts: ProcessFacts;
  /** Корни процессов прогонов модели. */
  roots: ReadonlySet<number>;
  platform: string;
  /**
   * Окружение панели: корни программ Windows и временные каталоги. По умолчанию
   * — своё; тесты задают чужое, чтобы правило Windows проверялось и на Linux.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Одноразовый стенд проверки (`throwaway-stand.ts`): данные панели и
   * конфигурация Claude — оба в temp ОС. Только тогда браузер автоматизации и
   * линия процессов, запустивших панель, сходят за человека.
   */
  stand?: { self: number };
}

export type GateVerdict = 'human' | 'model-process' | 'unverified';

/** Прогон модели среди предков — отказ раньше любого доверия. */
export function underRun(subject: number, gate: GateFacts): boolean {
  if (gate.roots.size === 0) return false;
  const { chain } = ancestryOf(gate.table, subject);
  return chain.some((pid) => gate.roots.has(pid));
}

/**
 * Почему звонящий — не браузер человека (для журнала и тестов), `undefined` —
 * браузер. Корень браузера — самый верхний живой предок ТОЙ ЖЕ установки
 * подряд от звонящего: сеть у Chromium держит ребёнок (`--type=utility`), а
 * ключи запуска видны только у главного процесса.
 */
export function browserRefusal(subject: number, gate: GateFacts): string | undefined {
  const env = gate.env ?? process.env;
  const installOf = (pid: number) =>
    browserInstallOf(gate.facts.get(pid)?.path, gate.platform, env);
  const install = installOf(subject);
  if (!install) return 'not-a-browser-install';
  let root = subject;
  for (const pid of ancestryOf(gate.table, subject).chain.slice(1)) {
    if (installOf(pid)?.dir !== install.dir) break;
    root = pid;
  }
  const fact = gate.facts.get(root);
  const line = fact?.commandLine;
  if (!fact || !line) return 'no-command-line';
  // Главный процесс браузера ушёл, а ребёнок остался — судить запуск не по чему.
  if (isBrowserChild(line) || !installOf(root)?.main) return 'root-is-a-child';
  // Windows: сеанс служб (0) рабочего стола не имеет — там человека нет.
  if (gate.platform === 'win32' && fact.session === 0) return 'service-session';
  return automationOf(line, fact.argv ?? [], gate.platform, tempRoots(env, gate.platform));
}

/**
 * Шов одноразового стенда: браузер автоматизации (по имени программы) или
 * процесс из живой линии предков панели — сама панель и проверка, поднявшая
 * её. Отвязанный помощник без предков сюда не попадает и на стенде.
 */
export function standTrusts(subject: number, gate: GateFacts): boolean {
  if (!gate.stand) return false;
  const name = gate.facts.get(subject)?.name ?? '';
  if (isAutomationBrowserName(name)) return true;
  return ancestryOf(gate.table, gate.stand.self).chain.includes(subject);
}

/** Локальное решение: браузер человека — да, процесс модели — нет, прочее — не узнан. */
export function localVerdict(subject: number, gate: GateFacts): GateVerdict {
  // Прогон среди предков отбивается раньше любого доверия — и на стенде тоже.
  if (underRun(subject, gate)) return 'model-process';
  if (browserRefusal(subject, gate) === undefined) return 'human';
  return standTrusts(subject, gate) ? 'human' : 'unverified';
}

/** Адрес из сети Tailscale: 100.64.0.0/10 и fd7a:115c:a1e0::/48. */
export function isTailnetAddress(value: string): boolean {
  const ipv4 = /^100\.(\d{1,3})\./.exec(value);
  if (ipv4) {
    const second = Number(ipv4[1]);
    return second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(value);
}

/**
 * Часть удалённого решения, которая принадлежит ЗАПРОСУ, а не процессу: ключ
 * доступа и адрес tailnet. Проверяется на каждом вызове, и у узнанного прокси тоже.
 */
export function remoteHopValid(input: { hop: string; bearer: boolean }): boolean {
  return input.bearer && isTailnetAddress(input.hop);
}

/**
 * Удалённое решение (телефон через Tailscale Serve). Принимается только то, что
 * прошло прокси ЭТОЙ машины: иначе ключ доступа, который модель читает из
 * `~/.agentdeck/api-token`, вместе с подставленным `X-Forwarded-For` открывал бы
 * ей тот же маршрут решения.
 */
export function remoteVerdict(
  subject: number,
  gate: GateFacts,
  input: { hop: string; bearer: boolean },
): GateVerdict {
  if (underRun(subject, gate)) return 'model-process';
  if (!remoteHopValid(input)) return 'unverified';
  const fact = gate.facts.get(subject);
  if (!fact) return 'unverified';
  // Прокси — служба И программа Tailscale: на Windows это нулевой сеанс, на
  // POSIX — root. Прежде хватало одного из двух, и любая служба сходила за
  // прокси (RF-DS-05).
  const service = gate.platform === 'win32' ? fact.session === 0 : fact.uid === 0;
  return isRemoteProxy(fact.name) && service ? 'human' : 'unverified';
}
