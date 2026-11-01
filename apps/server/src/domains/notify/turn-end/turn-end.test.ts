import { describe, expect, it } from 'vitest';
import { classifyTurnEnd } from './turn-end.ts';
import { askOf, claimsClosed, summaryOf, waitsInText } from './turn-text.ts';

/**
 * Конец хода для Telegram (решение владельца 30.10.2026): «Задача закрыта»,
 * «Агент ждёт вас» — или промежуточная остановка, о которой не пишут. Ответы —
 * по форме настоящих концов хода из выборки 28–30.10, имена и адреса заменены.
 */

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('classifyTurnEnd: закрыта', () => {
  it('«Задача «…» закрыта» в первом абзаце — итог без строки о /clear и без пути к PROGRESS', () => {
    const answer =
      'Задача «сторож групп и ревью» закрыта — `/clear`, затем "продолжай по `.agent/PROGRESS.md`". ' +
      'Всё закоммичено в `main`: коммит `581d21e5`, 293 файла. Пуш не делал.\n\n' +
      '- **Публичный репозиторий:** коммит есть.\n- **Копия:** не трогал.';
    expect(classifyTurnEnd({ answer })).toEqual({
      kind: 'closed',
      summary:
        'Задача «сторож групп и ревью» закрыта. Всё закоммичено в main: коммит 581d21e5, 293 файла.',
    });
  });

  it('заявление в последнем абзаце; ссылка — подписью, адрес прочь', () => {
    const answer =
      'Ревью опубликовано в [MR 12 — вкладка «Файлы»](https://tracker.example.com/shop/-/merge_requests/12): ' +
      'сводная заметка и 5 тредов.\n\n' +
      'Временная копия удалена. Задача закрыта: `/clear`, затем "продолжай по `.agent/PROGRESS.md`".';
    expect(classifyTurnEnd({ answer })).toEqual({
      kind: 'closed',
      summary:
        'Ревью опубликовано в MR 12 — вкладка «Файлы»: сводная заметка и 5 тредов. Временная копия удалена.',
    });
  });

  it('«Если нужно, скажите — сделаю коммит» — не ожидание: закрыта', () => {
    const answer =
      'Задача «Дека» закрыта. По части Деки полный гейт зелёный.\n\n' +
      'Ничего не закоммичено. Если нужно, скажите — сделаю коммит и пуш одним вопросом.';
    expect(classifyTurnEnd({ answer }).kind).toBe('closed');
  });

  it('секрет в итоге — под маской', () => {
    const turn = classifyTurnEnd({ answer: `Задача закрыта: ключ ${SECRET} записан в хранилище.` });
    expect(turn.kind).toBe('closed');
    expect(JSON.stringify(turn)).not.toContain('sk-ant-api03-AAAA');
  });
});

describe('classifyTurnEnd: ждёт', () => {
  it('вопрос в конце сильнее «закрыта»: что решить и варианты из перечня под вопросом', () => {
    expect(
      classifyTurnEnd({
        answer:
          'Задача закрыта, ревью готово.\n\nОпубликовать замечания тредами в MR?\n\n1. Да, все\n2. Только серьёзные',
      }),
    ).toEqual({
      kind: 'waiting',
      ask: 'Опубликовать замечания тредами в MR?',
      options: ['Да, все', 'Только серьёзные'],
    });
  });

  it('перечень вопросов — сами вопросы, вариантами не считаются', () => {
    const turn = classifyTurnEnd({
      answer:
        'Готово по сути.\n\n1. Закоммитить и запушить оба репозитория?\n2. Делать глобальное правило узких проверок по этой схеме?',
    });
    expect(turn).toEqual({
      kind: 'waiting',
      ask: 'Закоммитить и запушить оба репозитория? Делать глобальное правило узких проверок по этой схеме?',
      options: [],
    });
  });

  it('ожидание словами в последнем абзаце: «ждёт, пока вы …», «ждёт вашего «да»»', () => {
    expect(
      classifyTurnEnd({
        answer:
          'Закрыт «Сторож групп», кроме перепроверки на другой модели.\n\n' +
          'Открытым остаётся одно: перепроверка групп g1 и g5. Она ждёт, пока вы смените аккаунт.',
      }),
    ).toEqual({ kind: 'waiting', ask: 'Она ждёт, пока вы смените аккаунт.', options: [] });
    expect(
      classifyTurnEnd({
        answer:
          'Зона F закрыта.\n\nУдаление следов случайного запуска по-прежнему ждёт вашего «да».',
      }).kind,
    ).toBe('waiting');
  });

  it('висящий вопрос инструментом — его словами и вариантами, даже без «?» в ответе', () => {
    expect(
      classifyTurnEnd({
        answer: 'Нужно выбрать порт.',
        asked: true,
        question: `Какой порт оставить? Ключ ${SECRET}`,
        options: ['3000', '8080'],
      }),
    ).toEqual({
      kind: 'waiting',
      ask: 'Какой порт оставить? Ключ ••••••',
      options: ['3000', '8080'],
    });
  });

  it('вопрос посреди абзаца, за ним только рекомендация, — ждёт; «Почему? Потому что …» — нет', () => {
    expect(waitsInText('Публиковать треды в MR сейчас? Рекомендую да: замечания проверены.')).toBe(
      true,
    );
    expect(waitsInText('Почему упал гейт? Потому что стенд перезапускался, повторил.')).toBe(false);
  });

  it('вопрос внутри блока кода и условие «если жду ответа» — не ожидание', () => {
    expect(waitsInText('Задача закрыта.\n\n```\nread -p "Продолжить?"\n```')).toBe(false);
    expect(waitsInText('Правило записано: если жду вашего ответа, сразу пишу в Telegram.')).toBe(
      false,
    );
  });

  it('вопрос с условием остаётся вопросом, даже если под ним строка пояснения', () => {
    expect(
      waitsInText(
        'Ветка готова.\n\nЕсли всё устраивает — пушить в main?\nВетка feat/x, два коммита.',
      ),
    ).toBe(true);
  });

  it('что решить без вопроса — последняя фраза-ожидание, перечень под «Нужно ваше решение:»', () => {
    expect(askOf('Сделал три правки.\n\nНужно ваше решение:\n- коммит\n- пуш')).toEqual({
      ask: 'Нужно ваше решение.',
      options: ['коммит', 'пуш'],
    });
  });
});

describe('classifyTurnEnd: промежуточная остановка — тишина', () => {
  const reasonOf = (answer: string, facts = {}) => {
    const turn = classifyTurnEnd({ answer, ...facts });
    return turn.kind === 'intermediate' ? turn.reason : turn.kind;
  };

  it('шаг внутри задачи, «ещё не», «почти», «частично» — рассказ о ходе работы', () => {
    expect(reasonOf('Этап 4 ещё не закрыт: зоны B и F продолжают работу, я жду их отчётов.')).toBe(
      'progress',
    );
    expect(reasonOf('Фаза 2 закрыта. Дальше делаю фазу 3.')).toBe('progress');
    expect(reasonOf('Задача зоны API закрыта, остальные зоны идут.')).toBe('progress');
    expect(reasonOf('Задача почти закрыта: остался гейт.')).toBe('progress');
    expect(reasonOf('Задача закрыта частично: два пункта ждут стенда.')).toBe('progress');
    expect(reasonOf('Задача не закрыта.')).toBe('progress');
    expect(reasonOf('')).toBe('empty');
  });

  it('работа пошла дальше, оборвана, звено группы — молчит даже «закрыта» и вопрос', () => {
    const closed = 'Задача закрыта. Опубликовать?';
    expect(reasonOf(closed, { continued: true })).toBe('continued');
    expect(reasonOf(closed, { interrupted: true })).toBe('interrupted');
    expect(reasonOf(closed, { subtask: true, asked: true })).toBe('subtask');
  });

  it('фон и пробуждение глушат «закрыта», но не ожидание', () => {
    expect(reasonOf('Задача закрыта.', { background: true })).toBe('background');
    expect(reasonOf('Задача закрыта.', { wakeup: true })).toBe('wakeup');
    expect(reasonOf('Задача закрыта. Публиковать?', { background: true })).toBe('waiting');
  });
});

describe('claimsClosed и summaryOf', () => {
  it('подлежащее — сама задача; имя в кавычках не делает её частью', () => {
    expect(claimsClosed('Задача «зона веба» закрыта')).toBe(true);
    expect(claimsClosed('Вся работа выполнена')).toBe(true);
    expect(claimsClosed('Задача закрыта?')).toBe(false);
    expect(claimsClosed('Task done, except the gate')).toBe(false);
    expect(claimsClosed('All done.')).toBe(true);
  });

  it('итог — не длиннее предела, голое «Задача закрыта» и заголовок не в счёт', () => {
    expect(summaryOf('Задача закрыта.\n\n## Итог\n\nВход снова работает.')).toBe(
      'Вход снова работает.',
    );
    expect(summaryOf(`Задача закрыта: ${'длинная фраза '.repeat(40)}`).length).toBeLessThanOrEqual(
      220,
    );
  });
});
