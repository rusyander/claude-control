import { describe, expect, it } from 'vitest';
import { expandCommand, type SupervisorCommand } from './commands.ts';
import {
  buildSkillCatalog,
  matchSkillName,
  planSkillBody,
  planSkillTurn,
  type SkillCatalogEntry,
} from './skills-router.ts';
import { planSubagentRun } from './subagents.ts';

const entry = (name: string, priority: number, description = 'что делает'): SkillCatalogEntry => ({
  name,
  description,
  priority,
});

describe('каталог скиллов в бюджете символов', () => {
  it('влезающий каталог уходит целиком', () => {
    const catalog = buildSkillCatalog([entry('alpha', 1), entry('beta', 1)], 1000);

    expect(catalog.dropped).toEqual([]);
    expect(catalog.text.split('\n')).toHaveLength(2);
    expect(catalog.chars).toBe(catalog.text.length);
  });

  it('переполнение отбрасывает по приоритету, а не с конца списка', () => {
    // Порядок на входе нарочно обратный важности: если отбрасывание пойдёт «с
    // конца», уедет самый важный скилл, и заметить это будет нечем.
    const entries = [entry('zzz-low', 1), entry('aaa-high', 9), entry('mmm-mid', 5)];
    const catalog = buildSkillCatalog(entries, lineLengthOf('aaa-high'));

    expect(catalog.included.map((item) => item.name)).toEqual(['aaa-high']);
    expect(catalog.dropped.map((item) => item.name)).toEqual(['mmm-mid', 'zzz-low']);
  });

  it('отброшенное перечислено поимённо, а не посчитано', () => {
    const catalog = buildSkillCatalog([entry('alpha', 1), entry('beta', 1)], 0);

    expect(catalog.included).toEqual([]);
    expect(catalog.dropped.map((item) => item.name)).toEqual(['alpha', 'beta']);
    expect(catalog.text).toBe('');
  });

  it('при равном приоритете порядок устойчив между прогонами', () => {
    const entries = [entry('gamma', 3), entry('alpha', 3), entry('beta', 3)];

    expect(buildSkillCatalog(entries, 1000).included.map((item) => item.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(
      buildSkillCatalog([...entries].reverse(), 1000).included.map((item) => item.name),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('бюджет считается вместе с переводами строк', () => {
    // Иначе каталог «влезал» по расчёту и не влезал по факту — ровно на число строк.
    const entries = [entry('alpha', 2), entry('beta', 1)];
    const exact = buildSkillCatalog(entries, 1000);

    expect(buildSkillCatalog(entries, exact.text.length).included).toHaveLength(2);
    expect(buildSkillCatalog(entries, exact.text.length - 1).included).toHaveLength(1);
  });

  function lineLengthOf(name: string): number {
    return `- ${name}: что делает`.length;
  }
});

describe('скилл, названный в тексте', () => {
  const entries = [entry('review', 1), entry('deep-review', 1), entry('tests', 1)];

  it('находит скилл по косой черте', () => {
    expect(matchSkillName('сделай /deep-review по ветке', entries)).toBe('deep-review');
  });

  it('находит скилл по имени отдельным словом', () => {
    expect(matchSkillName('нужен review этой правки', entries)).toBe('review');
  });

  it('длинное имя выигрывает у вложенного короткого', () => {
    // `review` лежит внутри `deep-review`: без этого правила человек получил бы
    // тело другого скилла.
    expect(matchSkillName('запусти deep-review', entries)).toBe('deep-review');
  });

  it('имя внутри другого слова скиллом не считается', () => {
    expect(matchSkillName('это previewer, не скилл', entries)).toBeUndefined();
  });

  it('текста без скилла достаточно, чтобы вернуть ничего', () => {
    expect(matchSkillName('просто вопрос', entries)).toBeUndefined();
  });
});

describe('канал доставки тела скилла', () => {
  it('короткое тело едет инструкциями', () => {
    const plan = planSkillBody('короткое тело', {
      maxInstructionChars: 100,
      filePath: 'C:/tmp/skill.md',
    });

    expect(plan.channel).toBe('instructions');
    expect(plan.text).toBe('короткое тело');
  });

  it('длинное тело едет файлом, а не обрубается', () => {
    const body = 'x'.repeat(500);
    const plan = planSkillBody(body, { maxInstructionChars: 100, filePath: 'C:/tmp/skill.md' });

    expect(plan.channel).toBe('file');
    expect(plan.path).toBe('C:/tmp/skill.md');
    // Главное: тела в плане нет вовсе — значит его нечем нечаянно склеить в argv.
    expect(plan.text).toBeUndefined();
  });
});

describe('развёртывание слэш-команды', () => {
  const commands: SupervisorCommand[] = [
    { name: 'review', body: 'Проверь изменения и назови дефекты.' },
    { name: 'fix', body: 'Исправь: $ARGS в этом файле.', argsPlaceholder: '$ARGS' },
  ];

  it('команда заменяется своим телом', () => {
    expect(expandCommand('/review', commands)?.text).toBe('Проверь изменения и назови дефекты.');
  });

  it('аргументы встают на своё место', () => {
    expect(expandCommand('/fix отступы', commands)?.text).toBe('Исправь: отступы в этом файле.');
  });

  it('без места для аргументов они дописываются, а не теряются', () => {
    const expanded = expandCommand('/review только сервер', commands);

    expect(expanded?.text).toContain('Проверь изменения');
    // Написанное человеком обязано доехать целиком.
    expect(expanded?.text).toContain('только сервер');
    expect(expanded?.args).toBe('только сервер');
  });

  it('неизвестная команда уезжает как есть', () => {
    expect(expandCommand('/нетакой', commands)).toBeUndefined();
  });

  it('косая черта посреди фразы командой не считается', () => {
    expect(expandCommand('посмотри src/app/main.ts', commands)).toBeUndefined();
    expect(expandCommand('дата 12/09 подходит', commands)).toBeUndefined();
  });

  it('имя развёрнутой команды известно — его показывают человеку', () => {
    expect(expandCommand('/review', commands)?.name).toBe('review');
  });
});

describe('команда с именем не из латиницы', () => {
  // Имя команды — это имя файла на диске, и русское имя файла законно ровно так
  // же, как английское. Список разрешённых букв отсекал бы такую команду молча:
  // человек видел бы в переписке собственную строку с косой чертой.
  const commands: SupervisorCommand[] = [{ name: 'разбор', body: 'Разбери изменения.' }];

  it('разворачивается, как и латинская', () => {
    expect(expandCommand('/разбор', commands)?.text).toBe('Разбери изменения.');
  });

  it('аргументы к ней доезжают', () => {
    expect(expandCommand('/разбор только сервер', commands)?.args).toBe('только сервер');
  });
});

describe('ход разговора: каталог всегда, тело — по имени', () => {
  const entries = [entry('deep-review', 9), entry('tiny-note', 1)];
  const source = { text: 'тело скилла', filePath: 'C:/skills/deep-review/SKILL.md' };

  it('без названного скилла уезжает только каталог', () => {
    const plan = planSkillTurn({
      entries,
      budgetChars: 1000,
      prompt: 'посмотри на этот файл',
      readBody: () => source,
    });

    expect(plan.prefixes).toHaveLength(1);
    expect(plan.used).toBeUndefined();
  });

  it('названный скилл отдаётся ПУТЁМ, а не телом', () => {
    const plan = planSkillTurn({
      entries,
      budgetChars: 1000,
      prompt: 'запусти deep-review',
      readBody: () => source,
    });

    expect(plan.used).toBe('deep-review');
    const joined = plan.prefixes.join('\n');
    expect(joined).toContain(source.filePath);
    // Главный запрет: тело не уезжает вместе с промптом ни при каком размере.
    expect(joined).not.toContain(source.text);
  });

  it('отброшенный по бюджету скилл нельзя назвать: модель его не видела', () => {
    const plan = planSkillTurn({
      entries,
      budgetChars: '- deep-review: что делает'.length,
      prompt: 'запусти tiny-note',
      readBody: () => source,
    });

    expect(plan.used).toBeUndefined();
    expect(plan.dropped.map((item) => item.name)).toEqual(['tiny-note']);
  });

  it('нечитаемый скилл молчит, а не отдаёт пустое тело', () => {
    const plan = planSkillTurn({
      entries,
      budgetChars: 1000,
      prompt: 'запусти deep-review',
      readBody: () => undefined,
    });

    expect(plan.used).toBeUndefined();
    expect(plan.prefixes).toHaveLength(1);
  });

  it('владелец файла инструкций получает текст тела отдельно от промпта', () => {
    const plan = planSkillTurn({
      entries,
      budgetChars: 1000,
      prompt: 'запусти deep-review',
      readBody: () => source,
      instructionsBudget: 1000,
    });

    expect(plan.channel).toBe('instructions');
    expect(plan.instructionsText).toBe(source.text);
    // И даже тогда в промпт уезжает путь, а не тело: файл инструкций цель
    // читает сама, повторять его в запросе незачем.
    expect(plan.prefixes.join('\n')).not.toContain(source.text);
  });
});

describe('субагент как отдельный прогон', () => {
  const subagent = {
    name: 'reviewer',
    description: 'разбирает изменения',
    instructions: 'Ты разбираешь изменения и не правишь код.',
    skills: [entry('deep-review', 9)],
  };

  it('инструкции идут перед каталогом: роль сильнее списка скиллов', () => {
    const plan = planSubagentRun({ subagent, task: 'разбери МР 12', skillBudgetChars: 1000 });

    expect(plan?.prompt).toBe('разбери МР 12');
    expect(plan?.systemPrefix.indexOf('Ты разбираешь')).toBeLessThan(
      plan?.systemPrefix.indexOf('deep-review') ?? -1,
    );
  });

  it('пустая задача прогона не заводит', () => {
    expect(planSubagentRun({ subagent, task: '   ', skillBudgetChars: 1000 })).toBeUndefined();
  });

  it('контекст родителя субагенту не передаётся', () => {
    const plan = planSubagentRun({ subagent, task: 'разбери МР 12', skillBudgetChars: 1000 });

    // Смысл субагента в том, что длинная работа не возвращается в контекст
    // родителя. Протащить сюда его переписку значило бы отменить ровно это.
    expect(plan?.systemPrefix).not.toContain('МР 12');
    expect(plan?.prompt).toBe('разбери МР 12');
  });
});
