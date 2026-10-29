import type { Profile, ServiceRecipe, ServiceVar } from '@agentdeck/contracts/core/records';
import { classifyEnv, parseEnvText } from '../env/classify.ts';
import { isEnvSample } from './inputs.ts';
import { baseName, type ViewIndex } from './view.ts';

/**
 * Сервисы для тестов (04:124) и имена окружения (04:91). Рецепт — из compose-файла проекта:
 * образ, порты контейнера, литеральное окружение (подстановки `${…}` не берутся — их значения
 * живут вне репозитория). Сервис без `image` (собирается из исходников) рецептом не становится —
 * назван. testcontainers поднимают контейнеры сами, их образы статически не прочесть — назван.
 * Имена окружения — из образцов (`.env.example`…); значения не хранятся никогда.
 */

const IMAGE_SCHEMES: [RegExp, NonNullable<ServiceRecipe['scheme']>][] = [
  [/(^|\/)(postgres|postgis)[^/]*$/, 'postgres'],
  [/(^|\/)(mysql|mariadb)[^/]*$/, 'mysql'],
  [/(^|\/)mongo[^/]*$/, 'mongodb'],
  [/(^|\/)(redis|valkey)[^/]*$/, 'redis'],
  [/(^|\/)rabbitmq[^/]*$/, 'amqp'],
  [/(^|\/)(kafka|cp-kafka|redpanda)[^/]*$/, 'kafka'],
];

function schemeOfImage(image: string): ServiceRecipe['scheme'] {
  const name = image.split('@')[0]?.split(':')[0] ?? image;
  for (const [re, s] of IMAGE_SCHEMES) if (re.test(name)) return s;
  return undefined;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function containerPort(spec: string): number | undefined {
  const clean = unquote(spec).replace(/\/(tcp|udp)$/, '');
  const last = clean.split(':').pop() ?? '';
  return /^\d+$/.test(last) ? Number(last) : undefined;
}

interface RawService {
  name: string;
  image?: string;
  ports: number[];
  env: Record<string, string>;
}

/** Построчный разбор `services:` compose-файла (ключи, списки, карта окружения). */
export function parseCompose(text: string): RawService[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, ''));
  const out: RawService[] = [];
  const start = lines.findIndex((l) => /^services\s*:\s*$/.test(l));
  if (start < 0) return out;
  let svcIndent = -1;
  let cur: RawService | undefined;
  let section: 'ports' | 'env' | null = null;
  let sectionIndent = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    if (ind === 0) break;
    if (svcIndent < 0) svcIndent = ind;
    if (ind === svcIndent) {
      const m = /^\s*([\w.-]+)\s*:\s*$/.exec(line);
      cur = m ? { name: m[1] as string, ports: [], env: {} } : undefined;
      if (cur) out.push(cur);
      section = null;
      continue;
    }
    if (!cur) continue;
    if (section && ind <= sectionIndent) section = null;
    const key = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (!section && key) {
      const [, k, v] = key as unknown as [string, string, string];
      if (k === 'image' && v) cur.image = unquote(v);
      else if (k === 'ports' || k === 'environment') {
        section = k === 'ports' ? 'ports' : 'env';
        sectionIndent = ind;
        if (v.startsWith('[')) {
          for (const item of v.replace(/^\[|\]$/g, '').split(',')) {
            if (section === 'ports') {
              const p = containerPort(item);
              if (p !== undefined) cur.ports.push(p);
            }
          }
          section = null;
        }
      }
      continue;
    }
    if (section === 'ports') {
      const item = /^\s*-\s*(.+)$/.exec(line);
      const target = /^\s*-?\s*target\s*:\s*(\d+)/.exec(line);
      const p = target ? Number(target[1]) : item ? containerPort(item[1] as string) : undefined;
      if (p !== undefined && !cur.ports.includes(p)) cur.ports.push(p);
    } else if (section === 'env') {
      const item =
        /^\s*-\s*([A-Za-z_]\w*)=(.*)$/.exec(line) ?? /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(line);
      if (item) {
        const value = unquote(item[2] as string);
        if (!value.includes('${')) cur.env[item[1] as string] = value;
      }
    }
  }
  return out;
}

export interface RecipesFinding {
  recipes: ServiceRecipe[];
  envNames: string[];
  serviceVars: ServiceVar[];
  notes: Profile['notes'];
}

const TESTCONTAINERS = /testcontainers/i;

export function detectRecipes(view: ViewIndex): RecipesFinding {
  const recipes: ServiceRecipe[] = [];
  const notes: Profile['notes'] = [];
  const composeFiles = view.matching((p) =>
    /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(baseName(p)),
  );
  for (const f of composeFiles) {
    for (const s of parseCompose(f.text ?? '')) {
      if (!s.image) {
        notes.push({
          subject: `${f.path}#${s.name}`,
          why: 'service builds its own image: not a recipe',
        });
        continue;
      }
      // Образ уходит в argv движка позиционным словом: `-…` стал бы флагом, `${…}` и пробел —
      // не то, что поднимет compose. Такой сервис — не рецепт, назван.
      if (s.image.startsWith('-') || /[\s$]/.test(s.image)) {
        notes.push({
          subject: `${f.path}#${s.name}`,
          why: 'image is not a plain reference (flag-like or interpolated): not a recipe',
        });
        continue;
      }
      if (recipes.some((r) => r.name === s.name)) continue;
      const scheme = schemeOfImage(s.image);
      recipes.push({
        name: s.name,
        source: 'compose',
        image: s.image,
        ports: s.ports,
        env: s.env,
        ...(scheme ? { scheme } : {}),
      });
    }
  }
  const manifests = view.matching((p) =>
    /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|go\.mod|pyproject\.toml|Cargo\.toml)$/.test(
      p,
    ),
  );
  const tc = manifests.find((m) => TESTCONTAINERS.test(m.text ?? ''));
  if (tc)
    notes.push({
      subject: tc.path,
      why: 'testcontainers start their own containers: images not read statically',
    });
  const names = new Set<string>();
  const sample: { name: string; value: string }[] = [];
  for (const f of view.matching((p) => isEnvSample(baseName(p)))) {
    for (const row of parseEnvText(f.text ?? '')) {
      if (names.has(row.name)) continue;
      names.add(row.name);
      sample.push({ name: row.name, value: row.value });
    }
  }
  return {
    recipes,
    envNames: [...names].sort(),
    serviceVars: classifyEnv(sample),
    notes,
  };
}
