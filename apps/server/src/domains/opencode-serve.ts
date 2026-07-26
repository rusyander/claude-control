import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Сессионный режим OpenCode (IDEA-8) — вторая, более богатая форма ассистента
 * для НЕ-Claude провайдера.
 *
 * ЗАЧЕМ. One-shot (`opencode run "<промпт>"`) поднимает процесс на каждый вопрос
 * и памяти между вызовами не имеет — панель вынуждена склеивать всю историю в
 * один промпт. У OpenCode есть задокументированный локальный сервер
 * (`opencode serve`), который держит диалог сам: панель создаёт сессию один раз
 * и дальше шлёт только НОВОЕ сообщение. Это и есть разница между «basic» и
 * «богатым» ассистентом здесь: контекст на стороне CLI и настоящий id сессии.
 *
 * ЧТО ВЗЯТО ИЗ ДОКУМЕНТАЦИИ И ТОЛЬКО ИЗ НЕЁ:
 *  - `opencode serve --port <n> --hostname <адрес>` — локальный HTTP-сервер;
 *  - `GET /global/health` — проверка готовности;
 *  - `POST /session` — создать сессию, в ответе объект с `id`;
 *  - `POST /session/:id/message` с телом `{ parts: [{ type: 'text', text }] }` —
 *    отправить сообщение; ответ — `{ info, parts }`, текст лежит в частях с
 *    `type: 'text'`.
 * Поток событий (`GET /event`) панель НЕ разбирает: схема его `properties`
 * в документации не зафиксирована, а гадать про чужой формат здесь запрещено.
 * Ответ берётся из тела POST — оно задокументировано.
 *
 * FAIL-CLOSED И БЕЗ РЕГРЕССА: любая заминка (CLI не найден, сервер не поднялся,
 * ответ не той формы) — это `undefined`, а не ошибка наружу. Вызывающий молча
 * возвращается к one-shot, который работал и раньше. Ничего нового сломаться не
 * может: сессионный путь либо сработал целиком, либо его как будто не было.
 *
 * ЧЕСТНО: живым прогоном не проверено — OpenCode на машине разработки не
 * установлен. Форма запросов и путей — из документации, поведение закрыто
 * тестами на подменённых `spawn`/`fetch`.
 */

/** Ответ сессионного раннера: текст плюс id сессии, которую держит CLI. */
export interface OpencodeSessionReply {
  reply: string;
  sessionId: string;
}

export interface OpencodeServeDeps {
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  /** Команда CLI (на Windows — `opencode.cmd`). */
  command: string;
  /** Порт сервера. Не задан — свободный, выбранный ОС. */
  port?: number;
  /** Сколько ждать `GET /global/health`, мс. */
  readyTimeoutMs?: number;
  /** Таймаут одного HTTP-запроса к серверу, мс. */
  requestTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT = 20_000;
const DEFAULT_REQUEST_TIMEOUT = 180_000;
const HEALTH_POLL_INTERVAL = 250;

/** Свободный порт от ОС: сокет на `0`, читаем выданный номер, закрываем. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('порт не выдан'))));
    });
  });
}

const isWindows = (): boolean => process.platform === 'win32';

/**
 * Локальный сервер OpenCode: поднимается лениво, живёт до конца процесса панели,
 * держит карту «диалог панели → сессия CLI».
 *
 * Один экземпляр на процесс (`opencodeServe` ниже). В тестах создаётся свой — с
 * подменёнными `spawn`/`fetch`, чтобы ни один настоящий процесс не запускался.
 */
export class OpencodeServe {
  private child: ChildProcess | undefined;
  private killWith: typeof nodeSpawn | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<string | undefined> | undefined;
  private readonly sessions = new Map<string, string>();

  /** Адрес поднятого сервера или `undefined`, если поднять не удалось. */
  async ensure(deps: OpencodeServeDeps): Promise<string | undefined> {
    if (this.baseUrl) return this.baseUrl;
    // Параллельные запросы не должны поднимать ВТОРОЙ сервер: ждём один старт.
    this.starting ??= this.start(deps).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(deps: OpencodeServeDeps): Promise<string | undefined> {
    const spawnImpl = deps.spawnImpl ?? nodeSpawn;
    let port = deps.port;
    if (!port) {
      try {
        port = await freePort();
      } catch {
        return undefined;
      }
    }
    // Слушаем только петлю: сервер CLI — приватный инструмент панели, наружу его
    // не выставляем ни при каких настройках.
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];

    // stdio: 'ignore' — принципиально. По умолчанию потоки уходят в трубы,
    // которые НИКТО не читает: сервер CLI живёт до конца работы панели и всё
    // это время пишет в лог, а заполненный буфер трубы (единицы килобайт)
    // блокирует его запись НАВСЕГДА — сервер тихо замирает посреди ответа.
    // Вывод нам не нужен: о готовности мы узнаём опросом /global/health.
    let child: ChildProcess;
    try {
      child = isWindows()
        ? spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', deps.command, ...args], {
            windowsHide: true,
            stdio: 'ignore',
          })
        : spawnImpl(deps.command, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      return undefined;
    }

    // Процесс умер сам (CLI не найден, порт занят) — забываем адрес, следующий
    // запрос попробует поднять заново.
    child.on('error', () => this.forget());
    child.on('exit', () => this.forget());

    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = await this.waitHealthy(baseUrl, deps);
    if (!ready) {
      killTree(child, spawnImpl);
      return undefined;
    }

    this.child = child;
    this.killWith = spawnImpl;
    this.baseUrl = baseUrl;
    return baseUrl;
  }

  private async waitHealthy(baseUrl: string, deps: OpencodeServeDeps): Promise<boolean> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const deadline = Date.now() + (deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT);
    for (;;) {
      try {
        const res = await fetchImpl(`${baseUrl}/global/health`);
        if (res.ok) return true;
      } catch {
        // Сервер ещё не слушает — это нормальная часть ожидания старта.
      }
      if (Date.now() >= deadline) return false;
      await sleep(HEALTH_POLL_INTERVAL);
    }
  }

  /** Забыть поднятый сервер (процесс умер) — сессии вместе с ним недействительны. */
  private forget(): void {
    this.child = undefined;
    this.baseUrl = undefined;
    this.sessions.clear();
  }

  /**
   * Отправить сообщение в сессию диалога `conversationId`, создав её при первом
   * обращении. Любая неудача → `undefined`: вызывающий вернётся к one-shot.
   */
  async ask(
    conversationId: string,
    text: string,
    deps: OpencodeServeDeps,
  ): Promise<OpencodeSessionReply | undefined> {
    const baseUrl = await this.ensure(deps);
    if (!baseUrl) return undefined;

    let sessionId = this.sessions.get(conversationId);
    if (!sessionId) {
      sessionId = await this.createSession(baseUrl, deps);
      if (!sessionId) return undefined;
      this.sessions.set(conversationId, sessionId);
    }

    const reply = await this.sendMessage(baseUrl, sessionId, text, deps);
    if (reply === undefined) {
      // Сессия могла протухнуть вместе с сервером — не держим мёртвый id.
      this.sessions.delete(conversationId);
      return undefined;
    }
    return { reply, sessionId };
  }

  private async createSession(
    baseUrl: string,
    deps: OpencodeServeDeps,
  ): Promise<string | undefined> {
    const body = await this.request(baseUrl, '/session', {}, deps);
    if (!body || typeof body !== 'object') return undefined;
    const id = (body as { id?: unknown }).id;
    return typeof id === 'string' && id ? id : undefined;
  }

  private async sendMessage(
    baseUrl: string,
    sessionId: string,
    text: string,
    deps: OpencodeServeDeps,
  ): Promise<string | undefined> {
    const body = await this.request(
      baseUrl,
      `/session/${encodeURIComponent(sessionId)}/message`,
      { parts: [{ type: 'text', text }] },
      deps,
    );
    if (!body || typeof body !== 'object') return undefined;

    const parts = (body as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return undefined;

    // Берём только части `type: 'text'` — единственная форма, задокументированная
    // и на отправку, и на приём. Всё прочее (инструменты, служебные части) молча
    // пропускаем: показывать непонятую часть как ответ было бы выдумкой.
    const reply = parts
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('')
      .trim();

    return reply || undefined;
  }

  /** POST с телом JSON и таймаутом. Любая ошибка/не-2xx → `undefined`. */
  private async request(
    baseUrl: string,
    path: string,
    payload: unknown,
    deps: OpencodeServeDeps,
  ): Promise<unknown> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
    );
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Погасить сервер (выход панели, смена провайдера, тесты). */
  dispose(): void {
    if (this.child) killTree(this.child, this.killWith);
    this.forget();
  }

  /** Адрес поднятого сервера — для диагностики; поднимать сам не станет. */
  currentBaseUrl(): string | undefined {
    return this.baseUrl;
  }
}

/**
 * Снять сервер ЦЕЛИКОМ. На Windows CLI запущен через `cmd.exe /c`, и `kill()`
 * убил бы только оболочку — настоящий процесс остался бы держать порт.
 */
function killTree(child: ChildProcess, spawnImpl: typeof nodeSpawn = nodeSpawn): void {
  try {
    if (isWindows() && child.pid) {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill();
    }
  } catch {
    // Снятие процесса не должно ронять ответ пользователю.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Единственный экземпляр на процесс панели. */
export const opencodeServe = new OpencodeServe();

// Панель закрывается — сервер CLI не должен пережить её и держать порт.
process.once('exit', () => opencodeServe.dispose());
