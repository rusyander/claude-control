import { describe, expect, it } from 'vitest';
import type { PermissionDecision, PermissionItem } from '@agentdeck/contracts/portable-env';
import { permissionDecisions } from '@agentdeck/contracts/portable-env';
import { level } from './fidelity.ts';
import { modeRule, parsePermissionRule, translatePermission } from './permissions-map.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * ПЕРЕВОД ПРАВ (П2.2).
 *
 * Проверяется не «функция вернула строку», а три обещания тикета: ни один
 * `deny` и ни один `ask` не становится `allow` НИ У ОДНОЙ цели · у цели со
 * скалярным режимом правила не исчезают, а объявляются требующими провода ·
 * порядок правил (он значим у kimi) сохраняется.
 *
 * Таблица идёт по ВСЕМ десяти целям каталога, а не по выбранным: пара, забытая
 * в списке руками, — это ровно та пара, на которой запрет и превращается в
 * разрешение.
 */

const targets: ConfigProvider[] = [claudeProvider, ...CATALOG_PROVIDERS];

const source = {
  provider: 'claude',
  scope: 'global' as const,
  origin: 'file' as const,
  file: '/home/u/.claude/settings.json',
  plugin: null,
};

function permission(rule: string, decision: PermissionDecision): PermissionItem {
  return {
    id: `permission:${decision}-${rule}`,
    kind: 'permission',
    source,
    intent: `${decision}: ${rule}`,
    trigger: { on: 'always' },
    blocking: decision === 'allow' ? 'observes' : 'blocks',
    needs: { resolution: 'facts', facts: ['tool_name'], evidence: 'declared' },
    sideEffects: [],
    rule,
    decision,
    enabled: true,
    order: 0,
    raw: rule,
  };
}

/** Чем меньше разрешено, тем больше число. Порядок словаря — он же и шкала. */
function strictness(decision: PermissionDecision): number {
  return permissionDecisions.indexOf(decision);
}

describe('решение не ослабляется ни у одной цели', () => {
  for (const target of targets) {
    for (const decision of permissionDecisions) {
      it(`${target.id}: «${decision}» не становится слабее`, () => {
        const item = permission('Bash(git push:*)', decision);
        const verdict = level(item, target);

        // Приговор обязан назвать решение у КАЖДОЙ цели, где правило доезжает
        // правилом: им эмиттер и пишет. Молчащее поле здесь — это «понижено в
        // сторону строгости» без содержания, то есть заявление ни о чём.
        if (verdict.level !== 'native') {
          expect(verdict.level, `${target.id}/${decision}`).not.toBe('native');
          return;
        }
        expect(verdict.decision, `${target.id}/${decision}`).toBeDefined();
        expect(
          strictness(verdict.decision as PermissionDecision),
          `${target.id}/${decision} → ${String(verdict.decision)}`,
        ).toBeGreaterThanOrEqual(strictness(decision));

        const translated = translatePermission(
          item,
          verdict.decision as PermissionDecision,
          target,
        );
        if (translated.kind === 'refused') return;
        expect(strictness(translated.decision)).toBeGreaterThanOrEqual(strictness(decision));
      });
    }
  }

  it('ослабленное решение перевод отвергает исключением, а не строкой в отчёте', () => {
    expect(() => translatePermission(permission('Read', 'deny'), 'allow', claudeProvider)).toThrow(
      /ослабил решение/,
    );
    expect(() => translatePermission(permission('Read', 'ask'), 'allow', claudeProvider)).toThrow(
      /ослабил решение/,
    );
  });

  it('у цели без списка «спросить» правило ask доезжает ЗАПРЕТОМ, а не разрешением', () => {
    // Свойство каталога, а не имени: берём цель, у которой `ask` в `decisions`
    // нет. Сегодня таких две (cursor, gemini) — тест находит их сам.
    const noAsk = targets.filter(
      (target) =>
        target.permissionsConfig?.model === 'rules' &&
        !target.permissionsConfig.decisions.includes('ask'),
    );
    expect(noAsk.length).toBeGreaterThan(0);

    for (const target of noAsk) {
      const verdict = level(permission('Bash(rm -rf:*)', 'ask'), target);
      expect(verdict.level, target.id).toBe('native');
      expect(verdict.reason, target.id).toBe('decision_downgraded');
      expect(verdict.decision, target.id).toBe('deny');
    }
  });
});

describe('режим подтверждений целого CLI правилом не становится', () => {
  for (const target of targets) {
    it(`${target.id}: режим уходит рантайму, а не в список правил`, () => {
      const verdict = level(permission(modeRule('yolo'), 'allow'), target);
      expect(verdict.level, target.id).not.toBe('native');
      // Записать его нечем ни у кого: даже у цели, у которой свой режим есть,
      // перенос не переставляет чужую глобальную строгость.
      const translated = translatePermission(
        permission(modeRule('yolo'), 'allow'),
        'allow',
        target,
      );
      expect(translated, target.id).toEqual({ kind: 'refused', why: 'mode_is_whole_cli' });
    });
  }
});

describe('цель со скалярным режимом: правила не исчезают', () => {
  const scalar = targets.filter((target) => target.permissionsConfig?.model === 'mode');

  it('такие цели в каталоге есть — иначе проверка проверяет пустоту', () => {
    expect(scalar.map((target) => target.id).sort()).toEqual(['codex', 'goose']);
  });

  for (const target of scalar) {
    it(`${target.id}: правило объявлено требующим провода или текстом, но не потеряно`, () => {
      const verdict = level(permission('Bash(rm -rf:*)', 'deny'), target);
      expect(['wired', 'text', 'impossible'], target.id).toContain(verdict.level);
      // «Невозможно» здесь было бы молчанием о правиле: у обеих целей есть
      // раздел инструкций, и сила текста у правила остаётся.
      expect(verdict.level, target.id).not.toBe('impossible');
      expect(verdict.reason, target.id).toBe('no_mechanism');
    });
  }
});

describe('словарь инструментов цели', () => {
  const opencode = targets.find((target) => target.id === 'opencode') as ConfigProvider;

  it('переводится там, где он задокументирован', () => {
    const translated = translatePermission(permission('Bash(git status)', 'ask'), 'ask', opencode);
    expect(translated).toMatchObject({ kind: 'rule', tool: 'bash', rule: 'bash(git status)' });
  });

  it('закрытый словарь чужого имени не принимает — правило не пишется вовсе', () => {
    const translated = translatePermission(permission('Read', 'deny'), 'deny', opencode);
    expect(translated).toEqual({ kind: 'refused', why: 'tool_not_in_vocabulary' });
  });

  it('уточнение аргумента там, где формат его не держит, — отказ, а не запрет на всё', () => {
    // `Edit(src/**)`, записанный у OpenCode как `edit: "deny"`, запретил бы ВСЕ
    // правки вместо одного каталога: карта шаблонов задокументирована у `bash`.
    const translated = translatePermission(permission('Edit(src/**)', 'deny'), 'deny', opencode);
    expect(translated).toEqual({ kind: 'refused', why: 'argument_not_expressible' });
  });

  it('там, где словаря нет, строка едет как есть', () => {
    for (const target of targets.filter((item) => !item.permissionsConfig?.ruleGrammar)) {
      const translated = translatePermission(
        permission('Bash(git push:*)', 'deny'),
        'deny',
        target,
      );
      expect(translated, target.id).toMatchObject({ kind: 'rule', rule: 'Bash(git push:*)' });
    }
  });
});

describe('разбор правила канона', () => {
  it('аргумент — только в скобках на конце', () => {
    expect(parsePermissionRule('Bash(git push:*)')).toEqual({
      kind: 'rule',
      tool: 'Bash',
      argument: 'git push:*',
    });
    // Двоеточие внутри имени MCP-инструмента аргументом не является.
    expect(parsePermissionRule('mcp__server__tool')).toEqual({
      kind: 'rule',
      tool: 'mcp__server__tool',
      argument: null,
    });
    expect(parsePermissionRule(modeRule('untrusted'))).toEqual({
      kind: 'mode',
      mode: 'untrusted',
    });
  });
});
