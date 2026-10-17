/**
 * Что очередь тяжёлых шагов считает тяжёлым (хук `heavy-queue-hook.mjs`).
 *
 * Тяжёлое узнаётся тремя путями. По имени — раннеры и менеджеры пакетов. По
 * обёртке — та же команда в кавычках у скрипта-обёртки (`mustfail --cmd "npx
 * vitest run src"`). По опыту — гейт проекта зовётся своим скриптом
 * (`node .claude/tools/check-ticket.mjs`), имени которого очередь знать не может:
 * хук замеряет каждую команду и запоминает те, что шли дольше `learnMs()`. Без
 * опыта очередь видела 8 % тяжёлого времени четырёх групп 16.10 — гейты
 * проекта шли мимо неё (замер по стенограммам, 17.10).
 *
 * Имя смотрится только на месте запускаемой программы: `grep -rn vitest`,
 * `npm ls eslint`, `which tsc` ничего не гоняют, а вставали бы за чужим гейтом
 * на 25 минут (ревью A-F04).
 */

/**
 * Тяжёлое — гейт, сборка, полный прогон тестов: менеджер пакетов со скриптом
 * проверки, раннер напрямую, `tests-cli run`, Go/Python/Rust/JVM/make. Каждый
 * образец — от начала команды (`commandOf`): программа без пути и расширения.
 */
const HEAVY = new RegExp(
  [
    // Ключи с значением перед скриптом (`-C web`, `--dir web`, `--prefix web`, `--filter x`)
    // — одной парой: иначе `pnpm -C web test` в очередь не попадал (ревью A2-F4).
    String.raw`^(pnpm|npm|yarn|bun)\s+((--?(filter|C|dir|prefix|workspace|w|F)(=|\s+)\S+|-\S+|run|run-script|exec|dlx)\s+)*(test|tests|lint|type-?check|typecheck|build|e2e|verify|check|gate|ci|vitest|jest|tsc|eslint)\b`,
    String.raw`^(vitest|jest|tsc|eslint)(\s|$)`,
    String.raw`^playwright\s+test\b`,
    String.raw`^go\s+test\b`,
    String.raw`^((python[\d.]*|py)\s+-m\s+)?pytest\b`,
    String.raw`^cargo\s+(test|build|check|clippy|nextest|bench|doc)\b`,
    String.raw`^dotnet\s+(test|build)\b`,
    String.raw`^gradlew?(\s|$)`,
    String.raw`^mvnw?(\s|$)`,
    String.raw`^make\s+(test|lint|check|build)\b`,
    String.raw`^turbo\s+(run\s+)?(test|lint|build|check|typecheck|type-check)\b`,
    String.raw`^nx\s+(run-many|affected)\b`,
    String.raw`^(node|bun|deno|tsx)\s+(-\S+\s+)*\S*tests-cli(\.mjs)?\s+run\b`,
  ].join('|'),
);
/** Суженный прогон — один файл тестов или фильтр по имени: дёшев, без очереди. */
const NARROW =
  /\.(test|spec)\.[cm]?[jt]sx?\b|\btest_\w+\.py\b|_test\.go\b|\s(-t|--testNamePattern|-run|-k)\s/;
/**
 * Исключение из прогона — не сужение: `--exclude "**\/*.e2e.test.ts"` и
 * `--ignore=tests/test_slow.py` гоняют всё прочее (ревью A-F06).
 */
const EXCLUDE =
  /(^|\s)--?(exclude|ignore|ignore-glob|ignore-pattern|ignore-path|testPathIgnorePatterns|deselect)(=|\s+)\S+/g;
/** `go test ./... -run X` собирает все пакеты: фильтр по имени его не удешевляет. */
const ALL_PACKAGES = /(^|\s)\.\/\.\.\.(\s|$)/;
const narrow = (text) => {
  const own = text.replace(EXCLUDE, ' ');
  return NARROW.test(own) && !ALL_PACKAGES.test(own);
};
/**
 * Только чтение — справка, версия, список: не прогон. `-v` сюда не входит: у
 * `go test -v` и `pytest -v` это подробный вывод полного прогона.
 */
const READ_ONLY = /\s(--version|--help|-h|--list|list)(\s|$)/;
/** Раннер в любом виде, суженный тоже: его шаг объясняет длительность команды. */
const RUNNER =
  /^(vitest|jest|playwright|tsc|eslint|pytest|go\s+test|cargo|dotnet|gradlew?|mvnw?|turbo|nx|(python[\d.]*|py)\s+-m\s+pytest)\b/;
/**
 * Текст в кавычках — один аргумент, а не команда: `echo "pnpm test"` ничего не
 * гоняет. Пробелы в нём склеиваются, а не текст выбрасывается: путь в кавычках
 * (`node "C:/…/tests-cli.mjs" run`) остаётся узнаваемым.
 */
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const oneWord = (quoted) => quoted.replace(/\s+/g, '_');
const bare = (step) => step.replace(QUOTED, '""');

/**
 * Тело heredoc — данные скрипта, а не команды: `s.replace("npm test")` в нём не
 * прогон. Остаток строки с меткой — команда: `cat <<EOF > a && pnpm test` (ревью A-F10).
 */
const HEREDOC = /<<-?\s*(['"]?)([\w-]+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
const withoutHeredocs = (command) => String(command).replace(HEREDOC, '<<$2$3');

/** Положительное число из окружения или значение по умолчанию. */
export function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
/** С какой длительности команда считается тяжёлой по опыту. */
export const learnMs = () => numberEnv('AGENTDECK_HEAVY_LEARN_MS', 90_000);

/**
 * Шаги цепочки и конвейера вне кавычек: `pnpm lint && npx vitest run a.test.ts`
 * — два шага, и первый полный; `&&` внутри `--cmd "cd web && pnpm test"` шагом
 * не считается — это аргумент обёртки. Комментарий `# …` — не команда: апостроф
 * в нём открывал «кавычку» до конца команды (ревью A-F11).
 */
export function steps(command) {
  const text = withoutHeredocs(command);
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // `\"` внутри `"…"` и `\;` снаружи — экранированный знак, а не конец строки и не
    // разделитель: иначе код `node -e "…\"…\"…"` рассыпался на шаги-обрывки.
    if (ch === '\\' && quote !== "'") {
      current += text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    // `2>&1` и `&>` — перенаправление, а не разделитель шагов.
    const redirect = ch === '&' && (text[i - 1] === '>' || text[i + 1] === '>');
    if (two === '&&' || two === '||') {
      out.push(current);
      current = '';
      i += 1;
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && !redirect)) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((step) => step.trim()).filter(Boolean);
}

/**
 * Слова шага с учётом кавычек; у каждого — был ли он в кавычках. Ключ со
 * значением в кавычках (`--cmd="npx vitest run src"`) — два слова: ключ и строка.
 */
function words(step) {
  const out = [];
  for (const match of step.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(--?[\w.-]+=)(?=["'])|(\S+)/g)) {
    const plain = match[3] ?? match[4];
    out.push(
      plain === undefined
        ? // В `"…"` оболочка снимает экранирование: `\"pnpm build\"` внутри — снова строка.
          { text: match[2] ?? match[1].replace(/\\(["\\$`])/g, '$1'), quoted: true }
        : // Скобки подоболочки — не часть слова: `(cd web && npm run build)`.
          { text: plain.replace(/^\(+|\)+$/g, ''), quoted: false },
    );
  }
  return out;
}

/** Перенаправление (`2>&1`, `>/dev/null`, `<<EOF`) — не аргумент команды. */
const REDIRECT = /^(\d*[<>]|&>|>>)/;
/** Одинокий знак перенаправления: следующее слово — его цель (`> vitest.log`), не аргумент. */
const REDIRECT_ALONE = /^(\d*[<>]{1,2}|&>{1,2})$/;

/** Слова-аргументы шага: без перенаправлений и их целей. */
function argWords(step) {
  const out = [];
  const list = words(step);
  for (let i = 0; i < list.length; i += 1) {
    const word = list[i];
    if (!word.quoted && REDIRECT_ALONE.test(word.text)) i += 1;
    else if (word.quoted || !REDIRECT.test(word.text)) out.push(word);
  }
  return out;
}

/** Ждут сеть, человека или просто читают: их длительность — не нагрузка на процессор. */
const IDLE = new Set(
  (
    'sleep git curl wget gh glab ssh scp ping tail head cat less more grep egrep rg find ls dir ' +
    'echo printf sed awk wc sort uniq cut tr tee true false test [ cd pushd popd export set unset ' +
    'source . mkdir cp mv rm rmdir touch ln chmod pwd which where type read wait kill taskkill ' +
    'tasklist ps date basename dirname realpath jq diff cmp stat du df code start open explorer clip'
  ).split(' '),
);
/** Ключевые слова оболочки впереди шага: `do grep …`, `then pnpm test`. */
const SHELL_WORDS = new Set(
  'for while until do done if then else elif fi case esac in select function { } ! ('.split(' '),
);
/** Обёртки запуска: смотрим на то, что они запускают. */
const PREFIXES = new Set(
  'timeout nice time command exec nohup stdbuf env xargs sudo winpty cross-env'.split(' '),
);
/**
 * Запускалки чужой программы: `npx tsx a.ts`, `pnpm exec vitest`, `uv run pytest`.
 * Смотрим на запущенную: подпись `npx tsx` сводила в одну все скрипты под `tsx`
 * (ревью A-F08).
 */
const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx']);
const LAUNCH_VERBS = new Map([
  ['pnpm', ['exec', 'dlx']],
  ['yarn', ['exec', 'dlx']],
  ['npm', ['exec', 'x']],
  ['bun', ['x']],
  ['uv', ['run']],
  ['poetry', ['run']],
  ['pipenv', ['run']],
]);
/** Раннеры, которые `pnpm` и `yarn` запускают и без глагола: `pnpm vitest run`. */
const BINS = /^(vitest|jest|eslint|tsc|playwright)$/;
/** Интерпретатор со скриптом: подпись — путь скрипта, а не `node`. */
const INTERPRETER =
  /^(node|nodejs|python[\d.]*|py|bash|sh|zsh|pwsh|powershell|deno|bun|tsx|ts-node|ruby|perl|php)$/;
/** Код прямо в строке (`node -e`, `python -c`, `python - <<EOF`) подписи не имеет. */
const INLINE = new Set(['-e', '-c', '-p', '--eval', '--print', '-', '-command']);
/** Ключи интерпретатора со значением: `node --import tsx a.ts` — скрипт `a.ts`, не `tsx`. */
const INTERPRETER_VALUE_FLAGS = new Set(
  '--import -r --require --loader --experimental-loader -C --conditions -W -X'.split(' '),
);
/** Глагол запуска у менеджеров пакетов: подпись берёт и имя скрипта (`npm run build`). */
const RUNNER_VERBS = new Set(['run', 'run-script']);
/** Подкоманда с собственной подкомандой: `docker compose up` ≠ `docker compose ps`. */
const GROUPED = /^(docker|podman) compose$/;

const programOf = (word) =>
  word
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');

/** Место программы в шаге: после переменных, ключевых слов оболочки и обёрток. */
function programAt(list) {
  let at = 0;
  for (;;) {
    const word = list[at];
    if (!word || word.quoted) return at;
    const text = word.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || SHELL_WORDS.has(text)) at += 1;
    else if (PREFIXES.has(programOf(text))) {
      at += 1;
      // Ключи и числа обёртки: `timeout 180`, `nice -n 10`.
      while (list[at] && !list[at].quoted && /^(-\S*|\d+[smhd]?)$/.test(list[at].text)) at += 1;
    } else return at;
  }
}

/** Место программы, которую запускает запускалка (`npx -y tsx a.ts` → `tsx`). */
function launchedAt(list, from) {
  let at = from;
  for (;;) {
    const word = list[at];
    if (!word || word.quoted) return at;
    const program = programOf(word.text);
    const next = list[at + 1] && !list[at + 1].quoted ? list[at + 1].text : '';
    let to;
    if (LAUNCHERS.has(program)) to = at + 1;
    else if (LAUNCH_VERBS.get(program)?.includes(next)) to = at + 2;
    else if ((program === 'pnpm' || program === 'yarn') && BINS.test(next)) to = at + 1;
    else return at;
    while (list[to] && !list[to].quoted && list[to].text.startsWith('-')) to += 1;
    if (!list[to] || list[to].quoted) return at;
    at = to;
  }
}

/**
 * Команда шага с места запускаемой программы: её имя без пути и расширения,
 * дальше аргументы — в `text` текст в кавычках одним словом, в `bare` — пустым.
 */
function commandOf(step) {
  const list = argWords(step);
  const at = launchedAt(list, programAt(list));
  if (!list[at]) return null;
  const program = programOf(list[at].text);
  const tail = list.slice(at + 1);
  const join = (show) =>
    [program, ...tail.map((word) => (word.quoted ? show(word.text) : word.text))].join(' ');
  return { list, at, program, text: join(oneWord), bare: join(() => '""') };
}

/** Звенья пути без пустых и `.`: `./src/a` → `src`, `a`. */
const segments = (path) =>
  path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.');

/**
 * Путь скрипта без корня: три последних звена, без регистра. Один и тот же гейт
 * зовут из разных копий и то по относительному, то по полному пути
 * (`.claude/tools/check-ticket.mjs`, `/c/work/x-worktrees/y/.claude/tools/…`).
 */
const scriptKey = (path) => segments(path).slice(-3).join('/').toLowerCase();

/**
 * Адрес с учёткой (`postgres://user:pw@db`) в подпись не идёт: опыт лежит на
 * диске месяц (ревью A-F13).
 */
const ADDRESS = /:\/\/|@/;

/** Подпись шага для опыта: что запускается, без переменных, перенаправлений и обёрток. */
export function stepSignature(step) {
  const list = argWords(step);
  const at = launchedAt(list, programAt(list));
  const word = list[at];
  // Программа в кавычках или с подстановкой (`"$NODE"`, `$(which node)`) неизвестна.
  if (!word || word.quoted || /[$`]/.test(word.text)) return null;
  const program = programOf(word.text);
  if (!/^[\w.+-]+$/.test(program) || IDLE.has(program)) return null;
  const rest = list.slice(at + 1);
  if (INTERPRETER.test(program)) {
    for (let i = 0; i < rest.length; i += 1) {
      const text = rest[i].text;
      if (INLINE.has(text.toLowerCase())) return null;
      if (text === '-m' && rest[i + 1]) return `${program} -m ${rest[i + 1].text.toLowerCase()}`;
      if (INTERPRETER_VALUE_FLAGS.has(text)) i += 1;
      else if (!text.startsWith('-')) {
        return ADDRESS.test(text) ? null : `${program} ${scriptKey(text)}`;
      }
    }
    // Интерпретатор без скрипта читает код со стандартного ввода (`node <<EOF`).
    return null;
  }
  const args = rest
    .filter((item) => !item.text.startsWith('-'))
    .map((item) => (ADDRESS.test(item.text) ? '<address>' : item.text.toLowerCase()));
  const span = RUNNER_VERBS.has(args[0]) || GROUPED.test(`${program} ${args[0]}`) ? 2 : 1;
  return [program, ...args.slice(0, span)].join(' ');
}

/** Ключи раннеров, чьё значение — не выбор тестов: `--config ./web/vitest.config.ts`. */
const VALUE_FLAGS = new Set(
  (
    '--config -c --root -r --dir --project --workspace --reporter --outputFile --output-file -o ' +
    '--format -f --ext --rulesdir --cache-location --resolve-plugins-relative-to --env-file ' +
    '--shard --exclude --ignore-pattern --ignore-path --max-warnings --testTimeout --pool ' +
    '--environment --maxWorkers -w --selectProjects --testPathIgnorePatterns --mode'
  ).split(' '),
);
/** Подкоманды vitest перед выбором тестов. */
const VITEST_VERBS = new Set(['run', 'watch', 'related', 'bench', 'dev']);
/**
 * Папки пакетов монорепо и корни исходников: `apps/web` и `apps/server/src` —
 * весь пакет, а не его часть (ревью A-F05).
 */
const PACKAGE_DIRS = /^(apps|packages|libs|services|modules)$/i;
const SOURCE_ROOTS = /^(src|lib|test|tests|app|__tests__)$/i;
const narrowPath = (text) => {
  const parts = segments(text);
  if (parts.length < 2) return false;
  const inside = PACKAGE_DIRS.test(parts[0]) ? parts.slice(2) : parts;
  return (SOURCE_ROOTS.test(inside[0] ?? '') ? inside.slice(1) : inside).length > 0;
};

/**
 * Раннер, суженный до папки или файла: `npx vitest run src/components/Sidebar`,
 * `npx eslint src/pages/a/index.ts`. Суженным должен быть КАЖДЫЙ выбор: `src`,
 * `.` или `apps/web` гоняют весь пакет, и `vitest run src tests/unit` — всё
 * (ревью A-F05). В группах 16.10 таких прогонов было тридцать, каждый короче
 * двадцати секунд, и каждый вставал бы за чужим десятиминутным гейтом.
 */
function pathScoped(command) {
  if (!command || !/^(vitest|jest|eslint)$/.test(command.program)) return false;
  const { list, at } = command;
  let scoped = false;
  for (let i = at + 1; i < list.length; i += 1) {
    const { text, quoted } = list[i];
    const previous = list[i - 1];
    if (!quoted && text.startsWith('-')) continue;
    if (!previous.quoted && VALUE_FLAGS.has(previous.text)) continue;
    if (!quoted && i === at + 1 && VITEST_VERBS.has(text)) continue;
    if (/[$`*]/.test(text) || !narrowPath(text)) return false;
    scoped = true;
  }
  return scoped;
}

/** У оркестраторов `-t` — цель (`nx run-many -t test`), а не фильтр тестов по имени. */
const ORCHESTRATORS = new Set(['nx', 'turbo']);

/** Суженный или справочный по имени: аргументы в кавычках — тоже выбор тестов. */
const lightByName = (command) =>
  (!ORCHESTRATORS.has(command.program) && narrow(command.text)) ||
  READ_ONLY.test(command.text) ||
  pathScoped(command);

/**
 * Суженный или справочный шаг для опыта — по его собственным словам, не по
 * аргументам в кавычках: `mustfail --cmd "… a.test.ts"` гоняет файл на каждый
 * изменённый и шёл десять минут.
 */
export const isLight = (step) => {
  const command = commandOf(step);
  return Boolean(
    command && (narrow(command.bare) || READ_ONLY.test(command.bare) || pathScoped(command)),
  );
};

/** Шаг гоняет раннер — полный или суженный. Имя — только на месте программы (ревью A-F07). */
const runs = (step) => {
  const command = commandOf(step);
  return Boolean(command && (HEAVY.test(command.text) || RUNNER.test(command.text)));
};

/** Программы, у которых текст в кавычках — данные, а не команда для запуска. */
const TEXT_PROGRAMS = new Set([...IDLE].filter((name) => name !== 'cd'));
/** Ключи, чьё значение — текст для человека: `case add --title "npm test fails"` (ревью A-F12). */
const PROSE_FLAGS =
  /^--?(title|message|m|name|description|desc|body|note|notes|comment|summary|subject|expected|steps|reason|label|json)=?$/i;

/** Тяжёлая команда в кавычках у обёртки: `mustfail --cmd "npx vitest run src"`, `bash -c "pnpm test"`. */
function wrapsHeavy(step, learned) {
  const list = words(step);
  const head = list.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text));
  if (!head || head.quoted || TEXT_PROGRAMS.has(programOf(head.text))) return false;
  return list.some(
    (word, i) =>
      word.quoted &&
      /\s/.test(word.text) &&
      !(i > 0 && !list[i - 1].quoted && PROSE_FLAGS.test(list[i - 1].text)) &&
      isHeavy(word.text, learned),
  );
}

/** Тяжёл хоть один шаг — тяжела команда. `learned` — опыт: подпись → сколько шла. */
export function isHeavy(command, learned) {
  if (typeof command !== 'string') return false;
  return steps(command).some((step) => {
    const own = commandOf(step);
    if (own && !lightByName(own) && HEAVY.test(own.text)) return true;
    if (wrapsHeavy(step, learned)) return true;
    const signature = learned && !isLight(step) && stepSignature(step);
    return Boolean(signature && learned.get(signature) >= learnMs());
  });
}

/** Циклы опроса: `for`, `while`, `until` в начале шага. */
const LOOPS = new Set(['for', 'while', 'until']);

/**
 * Длительность команды не делится между шагами, если в ней есть ожидание:
 * `sleep`, цикл опроса, `wait` или запуск в фон `&` — иначе dev-сервер с
 * `sleep 60` за ним стал бы «тяжёлым» и вставал в очередь за чужим гейтом.
 * Ожидание — слово команды, а не кусок имени: `check-for-leaks.mjs` и
 * `wait-for-db` ожиданием не были (ревью A-F07).
 */
function attributable(command) {
  for (const step of steps(command)) {
    const list = words(step);
    if (list[0] && !list[0].quoted && LOOPS.has(list[0].text)) return false;
    const word = list[programAt(list)];
    if (word && !word.quoted && /^(sleep|wait)$/.test(programOf(word.text))) return false;
  }
  return !/(^|[^&>])&([^&>]|$)/.test(bare(withoutHeredocs(command)));
}

/**
 * Подписи, которым можно приписать длительность команды, или `null` — нельзя.
 * Долгую команду с раннером объясняет он сам: `prettier --write a && vitest run
 * a.test.ts` шла две минуты под нагрузкой, и `prettier` выучился бы тяжёлым.
 * Короткая же команда коротка целиком — она сдвигает вниз подпись любого шага.
 */
export function learnable(command, ms) {
  if (!attributable(command)) return null;
  const list = steps(command);
  if (ms >= learnMs() && list.some(runs)) return null;
  const signatures = list
    .filter((step) => !isLight(step))
    .map(stepSignature)
    .filter(Boolean);
  return signatures.length > 0 ? [...new Set(signatures)] : null;
}
