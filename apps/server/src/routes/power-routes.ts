import type { FastifyInstance } from 'fastify';
import type { PowerAccepted, PowerAction, PowerFailure, PowerStatus } from '@agentdeck/contracts';
import {
  executePower,
  powerCommand,
  probePower,
  systemPowerProbe,
  type CommandResult,
  type PowerProbe,
} from '../lib/power/power.ts';

/** Сколько ждём перед командой: ответ «принято» должен успеть дойти до телефона. */
export const POWER_DELAY_MS = 2_000;

/**
 * Сколько после запуска команды повтор не ставит вторую. Двойное нажатие или
 * повторённый телефоном запрос иначе запустили бы `shutdown /h` дважды, и машина
 * ушла бы в гибернацию снова сразу после пробуждения. Часы после сна ушли вперёд —
 * окно к пробуждению уже истекло, и новая просьба проходит как обычно.
 */
export const POWER_COOLDOWN_MS = 30_000;

/**
 * Холостой режим для одноразовых панелей (съёмка справки, проверки): они крутятся на
 * настоящей машине разработчика, и нажатая в кадре кнопка усыпила бы её. Команда
 * только пишется в журнал, ответ — как у настоящей.
 */
export const POWER_DRY_RUN_ENV = 'AGENTDECK_POWER_DRY_RUN';

const dryExecute = async (): Promise<CommandResult> => ({ code: 0, stdout: '' });

/** Чем выполнять команду: подставленным, холостым или настоящим системным вызовом. */
export function pickExecutor(
  deps: Pick<PowerRouteDeps, 'execute' | 'dryRun'>,
): (command: string, args: string[]) => Promise<CommandResult> {
  if (deps.execute) return deps.execute;
  const dryRun = deps.dryRun ?? process.env[POWER_DRY_RUN_ENV] === '1';
  return dryRun ? dryExecute : executePower;
}

export interface PowerRouteDeps {
  probe?: PowerProbe;
  execute?: (command: string, args: string[]) => Promise<CommandResult>;
  /** Холостой режим; по умолчанию — из `AGENTDECK_POWER_DRY_RUN=1`. */
  dryRun?: boolean;
  /** Запрет на сон от локального прогона: держится ли и как его снять перед сном. */
  awake: { held: () => boolean; release: () => void };
  schedule?: (run: () => void, ms: number) => void;
  log?: (message: string) => void;
  now?: () => number;
}

function parseAction(body: unknown): PowerAction | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;
  // Явное «да» в теле: случайный или повторённый запрос без него машину не усыпит.
  if (raw.confirm !== true) return undefined;
  return raw.action === 'hibernate' || raw.action === 'sleep' ? raw.action : undefined;
}

/**
 * Гибернация и сон машины с телефона. Выключать насовсем панель не умеет:
 * включить машину обратно телефон не может. Что умеет система — см. `lib/power`.
 */
export function registerPowerRoutes(app: FastifyInstance, deps: PowerRouteDeps): void {
  const probe = deps.probe ?? systemPowerProbe();
  const execute = pickExecutor(deps);
  const schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms).unref());
  const log = deps.log ?? ((message) => console.warn(message));
  const now = deps.now ?? Date.now;
  // Принятая команда: пока она ждёт паузы и ещё POWER_COOLDOWN_MS после — повтор не
  // ставит вторую, а получает тот же ответ.
  let inFlight: { action: PowerAction; runAt: number } | undefined;
  // Отказ системы приходит уже после ответа телефону — его показывает следующий опрос.
  let lastFailure: PowerFailure | undefined;

  const status = async (): Promise<PowerStatus> => ({
    ...(await probePower(probe)),
    awakeHeld: deps.awake.held(),
    lastFailure,
  });

  app.get('/api/power', () => status());

  app.post<{ Body: unknown }>('/api/power', async (request, reply) => {
    const action = parseAction(request.body);
    if (!action) {
      return reply.code(400).send({
        message: 'Запрос на сон или гибернацию составлен неверно',
        messageCode: 'power-request-invalid',
      });
    }
    if (inFlight && now() < inFlight.runAt + POWER_COOLDOWN_MS) {
      const same: PowerAccepted = {
        action: inFlight.action,
        inMs: Math.max(0, inFlight.runAt - now()),
      };
      return reply.code(202).send(same);
    }
    const { options } = await probePower(probe);
    const command = powerCommand(probe, action);
    if (!command || !options.some((option) => option.action === action && option.available)) {
      return reply.code(409).send({
        message: 'Этого режима на компьютере нет — проверьте, что он включён в системе',
        messageCode: 'power-unavailable',
      });
    }

    lastFailure = undefined;
    const ticket = { action, runAt: now() + POWER_DELAY_MS };
    inFlight = ticket;
    schedule(() => {
      // Запрет от локального прогона на Linux заблокировал бы команду (`systemd-inhibit
      // --mode=block`); человек сам попросил усыпить машину — запрет снимаем.
      deps.awake.release();
      log(
        `[power] ${action}: ${command.command} ${command.args.join(' ')}${execute === dryExecute ? ' (dry run)' : ''}`,
      );
      void execute(command.command, command.args).then((result) => {
        if (result.code === 0) return;
        // Система отказала — повтор разрешён сразу: ждать окна незачем.
        if (inFlight === ticket) inFlight = undefined;
        lastFailure = {
          action,
          at: new Date().toISOString(),
          message: result.stdout || `exit ${result.code}`,
        };
        log(`[power] ${action} failed: ${lastFailure.message}`);
      });
    }, POWER_DELAY_MS);

    const accepted: PowerAccepted = { action, inMs: POWER_DELAY_MS };
    return reply.code(202).send(accepted);
  });
}
