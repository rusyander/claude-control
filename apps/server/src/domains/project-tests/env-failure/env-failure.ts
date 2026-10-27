/**
 * Провал окружения — не красное кейса (M2, g5 27.10).
 *
 * `run --stale` без рецепта `GOFLAGS` из блокнота упал сборкой «missing go.sum entry»
 * до первого теста, и пять кейсов легли в историю красными — доставка потом требовала
 * их перепрогонов. Сборка Go, упавшая на модулях или тулчейне, говорит об окружении
 * копии, а не о коде ветки: такой провал ложится «заблокирован» с причиной (ворота
 * читают его окружением), как кейс без стенда у `run --health`.
 *
 * Исключение — `missing go.sum entry` у проекта, где `go.sum` под git: там недописанный
 * `go.sum` — дефект ветки (не сделан `go mod tidy`), и он остаётся красным.
 */

/** Признаки провала окружения Go в тексте падения; `goSum` — только при go.sum вне git. */
const GO_SUM = /missing go\.sum entry/;
const ENVIRONMENT = [
  /go: updates to go\.mod needed/,
  /go: inconsistent vendoring/,
  /requires go >= \S+ \(running go \S+/,
  /go: downloading go\S+ .*(?:toolchain not available|cannot find)/,
  /toolchain not available/,
  /go: \S+: (?:Get|dial tcp|lookup) [^\n]*(?:proxy\.golang\.org|timeout|no such host)/,
  /go: (?:open|reading) [^\n]*\.mod: (?:no such file|The system cannot find)/,
];

export interface EnvironmentVerdict {
  /** Отчёт, где провалы окружения — `status="blocked"` с `<skipped message>`. */
  content: string;
  /** Имена тестов, переложенных в «заблокирован». */
  blocked: string[];
  /** Остался ли хоть один настоящий провал. */
  red: boolean;
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const encode = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Строка-признак провала окружения или `undefined`. */
export function environmentCause(text: string, goSumTracked: boolean): string | undefined {
  const plain = decode(text);
  const patterns = goSumTracked ? ENVIRONMENT : [GO_SUM, ...ENVIRONMENT];
  for (const pattern of patterns) {
    const line = plain.split('\n').find((item) => pattern.test(item));
    if (line) return line.trim().slice(0, 240);
  }
  return undefined;
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const FAILURE = /<(failure|error)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/;

/** JUnit с провалами окружения, переложенными в «заблокирован» с причиной. */
export function blockEnvironmentFailures(xml: string, goSumTracked: boolean): EnvironmentVerdict {
  const blocked: string[] = [];
  let red = false;
  const content = xml.replace(TESTCASE, (whole, attributes: string, body?: string) => {
    if (!body) return whole;
    const failure = FAILURE.exec(body)?.[0];
    if (!failure) return whole;
    const cause = environmentCause(failure, goSumTracked);
    if (!cause) {
      red = true;
      return whole;
    }
    blocked.push(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? '?');
    const reason = `Окружение, не код: ${cause}`;
    const head = attributes.replace(/\s+status="[^"]*"/, '');
    return `<testcase${head} status="blocked"><skipped message="${encode(reason)}"/></testcase>`;
  });
  return { content, blocked, red };
}
