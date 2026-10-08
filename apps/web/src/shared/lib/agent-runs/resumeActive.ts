import { controllers, caughtUp } from './agent-runs.state';
import { loadSpend } from './agent-runs.spend';
import { apiClient } from '@shared/api/client';
import { ensureSlotsWatch, rebalance } from './agent-runs.slots';
import { rebuildStatuses, ensureWatchdog } from './agent-runs.statuses';
import { finalize } from './agent-runs.lifecycle';
import { loadQueue } from './loadQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { findKey } from './findKey';

/** Знаем ли мы прогон по СЕРВЕРНОМУ ключу — тому, под которым его завела чужая вкладка. */
export function ownerOfServerKey(key: string): string | undefined {
  for (const [own, run] of runs) if (run.serverRunId === key) return own;
  return undefined;
}

/**
 * Подхватить прогоны, которые идут на сервере, но которых нет в этом сторе, —
 * после перезагрузки страницы. Тянем каждый с нуля, восстанавливая вывод.
 */
export async function resumeActive(): Promise<void> {
  // Заодно подтягиваем накопленный расход — чтобы счётчик не был нулём после F5.
  void loadSpend();

  let active: {
    chatId: string;
    sessionId?: string;
    projectPath?: string;
    seq: number;
    startedAt?: number;
    /** `done` — прогон закончился и лежит в grace-буфере ради догона хвоста. */
    status?: 'running' | 'done';
    /** Чем прогон запущен: у подхваченного своей записи об этом нет. */
    model?: string;
    /** Усыновлён сервером после его перезапуска: процесс жив, потока вывода нет. */
    detached?: true;
  }[];
  try {
    const response = await apiClient.get('/chat/active');
    active = response.data as typeof active;
  } catch {
    return;
  }

  ensureSlotsWatch();
  // Кого сервер назвал в этот раз — по нашим ключам. Припаркованный прогон, не
  // названный никем, кончился и вышел из grace-буфера, пока у него не было
  // потока: закрываем его ниже, иначе он «работал» бы вечно.
  const listed = new Set<string>();

  for (const info of active) {
    // Один разговор живёт в двух написаниях: временное `new-…`, под которым он
    // стартовал, и настоящий `sessionId`, под которым его знает сервер. Сверять
    // только `info.chatId` мало — вкладка, начавшая разговор, помнит его под
    // первым, а `/chat/active` называет вторым (или наоборот, после F5). Отсюда
    // и брались две строки в пульте на один разговор, две точки и два потока к
    // одному прогону; `findKey` сводит написания, для того и заведён. Третье
    // написание — ключ, под которым прогон завела чужая вкладка: мы его знаем
    // (по нему идут поток и остановка), но своим именем зовём разговор иначе.
    const known = findKey(info.chatId) ?? findKey(info.sessionId) ?? ownerOfServerKey(info.chatId);
    if (known) {
      listed.add(known);
      // Припаркованный кончился: поток ему теперь нужен только за хвостом —
      // цена, расход, вопрос, — а «работает» у законченного не показываем.
      const run = runs.get(known);
      if (run?.parked && info.status === 'done' && !run.tailOnly) {
        setRun(known, { tailOnly: true, status: 'idle', text: '', thinking: '' });
        rebuildStatuses();
        emit();
        continue;
      }
      // Новый ход разговора, чей прошлый ход у нас уже закрыт: его начал не этот
      // таб — сам CLI (кончилась фоновая задача агента), телефон или соседнее
      // окно. Раньше такой прогон пропускался, раз ключ знаком, и лента молчала
      // до перезагрузки. Новизну сверяем по серверному времени старта: ход,
      // закрытый у нас на мгновение раньше, чем на сервере, начался не позже.
      if (
        run &&
        run.status !== 'running' &&
        !run.parked &&
        !controllers.has(known) &&
        info.status === 'running' &&
        run.startedAt !== undefined &&
        info.startedAt !== undefined &&
        info.startedAt > run.startedAt
      ) {
        ensureWatchdog();
        setRun(known, {
          sessionId: info.sessionId ?? run.sessionId,
          ...(info.chatId !== known ? { serverRunId: info.chatId } : {}),
          startedAt: info.startedAt,
          ...(info.model ? { model: info.model } : {}),
          status: 'running',
          tailOnly: undefined,
          text: '',
          thinking: '',
          tools: [],
          tokens: 0,
          textUsage: undefined,
          costUsd: undefined,
          error: undefined,
          askedQuestion: false,
          permissions: [],
          stalled: undefined,
          lastEventAt: Date.now(),
          parked: true,
          ...(info.detached ? { detached: true } : {}),
        });
        rebuildStatuses();
        emit();
      }
      continue;
    }
    if (controllers.has(info.chatId)) continue;
    // Законченный прогон, чей хвост уже дотянут (тем же `startedAt`), — это не
    // новый ход, а всё та же минута grace: пропускаем, иначе он подхватывался
    // бы заново на каждом такте опроса.
    const finished = info.status === 'done';
    if (finished && caughtUp.get(info.chatId) === info.startedAt) continue;
    ensureWatchdog();
    listed.add(info.chatId);
    // Поток не открываем здесь: прогон встаёт припаркованным, а поток ему
    // раздаёт `rebalance` ниже — по приоритету и в пределах бюджета.
    setRun(info.chatId, {
      id: info.chatId,
      sessionId: info.sessionId,
      projectPath: info.projectPath,
      startedAt: info.startedAt,
      // Чем ведётся: событие сессии назовёт то же имя, но оно придёт с потоком,
      // а поток припаркованному прогону достаётся не сразу.
      model: info.model,
      // Законченный заводим сразу законченным: «работает» у него не будет ни
      // секунды, а поток ниже дотянет только хвост — цену, расход, вопрос.
      status: finished ? 'idle' : 'running',
      tailOnly: finished,
      text: '',
      thinking: '',
      tools: [],
      tokens: 0,
      textUsage: undefined,
      costUsd: undefined,
      error: undefined,
      askedQuestion: false,
      permissions: [],
      lastEventAt: Date.now(),
      // Дописанное, пережившее перезагрузку: прогон тот же, значит и очередь
      // его — уйдёт по концу хода, как ушла бы без перезагрузки.
      queued: loadQueue(info.sessionId, info.chatId),
      parked: true,
      // Подхваченный сервером без потока: пузыря не будет и после того, как
      // поток достанется, — ставим метку здесь, до первого события.
      ...(info.detached ? { detached: true } : {}),
    });
    rebuildStatuses();
    emit();
  }

  // Припаркованные, которых сервер больше не называет, кончились без нас.
  // Обрывок текста у такого не правда — правда в транскрипте, поэтому
  // закрываем его как потерявший связь: лента покажет историю целиком.
  for (const [key, run] of runs) {
    if (!run.parked || controllers.has(key) || listed.has(key)) continue;
    setRun(key, { parked: undefined, stalled: true });
    finalize(key);
  }

  rebalance();
}
