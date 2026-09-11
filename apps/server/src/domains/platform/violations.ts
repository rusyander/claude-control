import type {
  PlatformGatewayEvent,
  PlatformViolationAction,
  PlatformViolationReport,
  PlatformViolationRow,
} from '@agentdeck/contracts';

/**
 * Проверки контента контура — СВОДКА, а не вызов.
 *
 * Гардрейлы работают сами, в полосе запроса: панель их не зовёт, не настраивает
 * и отключить не может. Всё, что ей принадлежит здесь, — честно показать, что
 * они сделали, и не соврать про причину. Поэтому модуль умеет ровно одно:
 * сложить след запросов в перечень «проверка → сколько раз → что случилось».
 *
 * ТЕКСТА, НА КОТОРОМ СРАБОТАЛА ПРОВЕРКА, ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. Он не
 * отфильтровывается на этом шаге — его нет уже во входе: имена нарушений
 * просеиваются в `gateway/status.ts` при разборе ответа контура, а сюда приходит
 * готовый след. Сложение чисел не может добавить того, чего в слагаемых нет.
 *
 * Три исхода различаются намеренно. «Запрос не приняли» человек чинит в своём
 * запросе; «ответ оборвали» — глядя на то, что модель успела сказать; «данные
 * замаскировали» не чинится вовсе, но знать о нём важнее всего: ответ пришёл
 * целым, и без пометки человек считает, что модель видела его запрос, а она
 * видела другой.
 *
 * НАЗВАНИЯ — необязательная часть кадра. Просеиватель имён строг намеренно
 * (в них приезжает текст, на котором сработала проверка), и ответ контура,
 * названий не приславший или приславший их в незнакомом виде, — обычное дело:
 * ни одного живого 451 никто ещё не видел. Поэтому безымянное срабатывание не
 * пропускается, а считается своим счётчиком: сказать «проверки молчали» про
 * запрос, который контур не принял, — ровно та ложь, ради которой заведена вся
 * сводка.
 */

/**
 * Что случилось в этом запросе. Может быть и несколько сразу: контур умеет
 * замаскировать часть данных и всё равно оборвать ответ дальше по потоку.
 */
function actionsOf(event: PlatformGatewayEvent): PlatformViolationAction[] {
  const actions: PlatformViolationAction[] = [];
  if (event.masked) actions.push('masked');
  if (event.interrupted) actions.push('interrupted');
  // Запрос не приняли: ответа не было вовсе. Читаем ФАКТ отказа проверок, а не
  // код ответа: клиенту 451 уезжает четырёхсотым, и по коду он неотличим от
  // отклонённого ключа, кончившегося бюджета и лимита частоты. Именно «не
  // оборван»: обрыв — это уже начавшийся ответ, и валить их в одну строку
  // значило бы стереть разницу, ради которой строки и разделены.
  if (!event.interrupted && event.blocked) actions.push('blocked');
  return actions;
}

export interface ViolationReportOptions {
  /**
   * Считать только по этим контурам. Панель обслуживает их несколько, и след
   * выключенного контура на экране включённого — то же враньё, что чужая
   * строка: выключение обязано возвращать раздел к прежнему виду.
   */
  platformIds?: string[];
}

/**
 * След запросов → сводка проверок.
 *
 * `since` берётся от самого старого следа, а не от старта процесса: след
 * ограничен по длине, и после полусотни запросов «с момента запуска» стало бы
 * неправдой. Пусто — запросов через шлюз не было ни одного, и это честнее нуля:
 * ноль читается как «проверки ничего не нашли».
 */
export function violationReport(
  events: PlatformGatewayEvent[],
  options: ViolationReportOptions = {},
): PlatformViolationReport {
  const byName = new Map<string, PlatformViolationRow>();
  let total = 0;
  let maskedUnnamed = 0;
  let blockedUnnamed = 0;
  let interruptedUnnamed = 0;
  let since: string | undefined;

  for (const event of events) {
    if (options.platformIds && !options.platformIds.includes(event.platformId)) continue;
    if (!since || (event.at && event.at < since)) since = event.at || since;

    const actions = actionsOf(event);
    if (event.violations.length === 0) {
      // Названий нет — но исход есть, и он важнее названий. Пропустив его, мы
      // показали бы «проверки ни разу не срабатывали» человеку, у которого
      // запрос не приняли или ответ оборвали у него на глазах.
      if (actions.includes('masked')) maskedUnnamed += 1;
      if (actions.includes('interrupted')) interruptedUnnamed += 1;
      if (actions.includes('blocked')) blockedUnnamed += 1;
      continue;
    }

    for (const name of event.violations) {
      total += 1;
      const row = byName.get(name);
      if (!row) {
        byName.set(name, {
          name,
          count: 1,
          lastAt: event.at,
          actions: [...actions],
          platformIds: [event.platformId],
        });
        continue;
      }
      row.count += 1;
      // Последний по ВРЕМЕНИ, а не последний в списке: порядок следов зависит от
      // того, как их складывает журнал, и полагаться на него незачем.
      if (event.at > row.lastAt) row.lastAt = event.at;
      for (const action of actions) {
        if (!row.actions.includes(action)) row.actions.push(action);
      }
      if (!row.platformIds.includes(event.platformId)) row.platformIds.push(event.platformId);
    }
  }

  const rows = [...byName.values()].sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );

  return {
    rows,
    total,
    maskedUnnamed,
    blockedUnnamed,
    interruptedUnnamed,
    ...(since ? { since } : {}),
  };
}
