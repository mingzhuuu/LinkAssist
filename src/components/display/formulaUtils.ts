import { evaluateExpression } from '../../lib/numericExpression';

export interface FormulaVariableDefinition {
  identifier: string;
  label: string;
}

export type FormulaVariableContext = Record<string, number | undefined>;

const IDENTIFIER_PATTERN = /^[$_\p{L}][$_\p{L}\p{N}]*$/u;

const RESERVED_IDENTIFIERS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'x',
  'yield',
]);

function normalizeIdentifier(label: string, fallback: string): string {
  const compact = label.trim().replace(/[^$_\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  const base = compact || fallback;
  const startsValid = /^[$_\p{L}]/u.test(base);
  const candidate = startsValid ? base : `_${base}`;
  return RESERVED_IDENTIFIERS.has(candidate) ? `_${candidate}` : candidate;
}

export function buildFormulaVariableDefinitions(
  sources: Array<{ label?: string | null; fallback: string }>,
): FormulaVariableDefinition[] {
  const used = new Set<string>();

  return sources.map(({ label, fallback }) => {
    const displayLabel = label?.trim() || fallback;
    const base = normalizeIdentifier(displayLabel, fallback);
    let identifier = base;
    let counter = 2;

    while (used.has(identifier)) {
      identifier = `${base}_${counter}`;
      counter += 1;
    }

    used.add(identifier);
    return { identifier, label: displayLabel };
  });
}

export function coerceFormulaNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function evaluateNumericFormula(
  value: number,
  formula: string,
  variables: FormulaVariableContext = {},
): number {
  if (!formula || formula.trim() === '') {
    return value;
  }

  const entries = Object.entries(variables).filter(([identifier]) => (
    IDENTIFIER_PATTERN.test(identifier) && !RESERVED_IDENTIFIERS.has(identifier)
  ));

  try {
    const result = evaluateExpression(formula, { ...Object.fromEntries(entries), x: value });
    return typeof result === 'number' && Number.isFinite(result) ? result : value;
  } catch {
    return value;
  }
}
