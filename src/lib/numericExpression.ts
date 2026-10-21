/** Numeric expressions only: no JavaScript evaluation, objects, strings or ambient globals. */
type Scope = Record<string, number | undefined>;
type Expression = (scope: Scope) => number;
const functions: Record<string, (...values: number[]) => number> = Object.assign(Object.create(null), {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
  sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow, min: Math.min, max: Math.max,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, atan2: Math.atan2, log: Math.log, log2: Math.log2,
  log10: Math.log10, exp: Math.exp, sign: Math.sign, hypot: Math.hypot,
});
const constants: Record<string, number> = Object.assign(Object.create(null), { PI: Math.PI, E: Math.E });
const precedence: Record<string, number> = Object.assign(Object.create(null), {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 12,
});
const cache = new Map<string, Expression | Error>();
const MAX_TOKENS = 256;

function binary(operator: string, a: Expression, b: Expression): Expression {
  return (s) => {
    const x = a(s);
    // Preserve short-circuit semantics for missing variables in inactive branches.
    if (operator === '&&') return x ? b(s) : x;
    if (operator === '||') return x || b(s);
    const y = b(s);
    switch (operator) {
      case '+': return x + y; case '-': return x - y; case '*': return x * y;
      case '/': return x / y; case '%': return x % y; case '**': return x ** y;
      case '&': return x & y; case '|': return x | y; case '^': return x ^ y;
      case '<<': return x << y; case '>>': return x >> y; case '>>>': return x >>> y;
      case '<': return Number(x < y); case '<=': return Number(x <= y);
      case '>': return Number(x > y); case '>=': return Number(x >= y);
      case '==': case '===': return Number(x === y);
      case '!=': case '!==': return Number(x !== y);
      default: throw new Error('Unsupported operator');
    }
  };
}

function parse(source: string): Expression {
  if (source.length > 2048) throw new Error('Formula exceeds 2048 characters');
  const tokens: string[] = [];
  let rest = source.trim();
  while (rest) {
    const match = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|(?:Math\.)?[$_\p{L}][$_\p{L}\p{N}]*|>>>|===|!==|\*\*|&&|\|\||<=|>=|==|!=|<<|>>|[+\-*/%()?:,<>!~&|^])/u.exec(rest);
    if (!match) throw new Error(`Unsupported formula syntax near "${rest.slice(0, 16)}"`);
    tokens.push(match[0]);
    if (tokens.length > MAX_TOKENS) throw new Error('Formula is too complex');
    rest = rest.slice(match[0].length).trimStart();
  }
  let cursor = 0;
  const take = (expected: string) => {
    if (tokens[cursor++] !== expected) throw new Error(`Expected "${expected}"`);
  };
  const expression = (minimum = 0): Expression => {
    const token = tokens[cursor++];
    if (!token) throw new Error('Expected a number, variable or function');
    let left: Expression;
    if (token === '(') {
      left = expression();
      take(')');
    } else if (['+', '-', '!', '~'].includes(token)) {
      const operand = expression(11);
      left = (s) => {
        const n = operand(s);
        return token === '-' ? -n : token === '!' ? Number(!n) : token === '~' ? ~n : n;
      };
    } else if (/^(?:\d|\.)/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('Number must be finite');
      left = () => value;
    } else if (/^(?:Math\.)?[$_\p{L}][$_\p{L}\p{N}]*$/u.test(token)) {
      const name = token.replace(/^Math\./, '');
      if (tokens[cursor] === '(') {
        const fn = functions[name];
        if (!fn) throw new Error(`Function "${token}" is not allowed`);
        cursor++;
        const args: Expression[] = [];
        if (tokens[cursor] !== ')') {
          do {
            if (args.length) take(',');
            args.push(expression());
          } while (tokens[cursor] === ',');
        }
        take(')');
        if (!args.length || args.length > 16) throw new Error('Functions require 1–16 arguments');
        left = (s) => fn(...args.map(arg => arg(s)));
      } else if (token.startsWith('Math.')) {
        if (!Object.prototype.hasOwnProperty.call(constants, name)) throw new Error(`Constant "${token}" is not allowed`);
        left = () => constants[name];
      } else {
        if (['globalThis', 'window', 'document', 'this', 'constructor', '__proto__', 'prototype'].includes(token)) {
          throw new Error(`Variable "${token}" is not allowed`);
        }
        left = (s) => {
          const value = Object.prototype.hasOwnProperty.call(s, token) ? s[token] : undefined;
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Unknown variable "${token}"`);
          return value;
        };
      }
    } else {
      throw new Error(`Unexpected "${token}"`);
    }
    while (cursor < tokens.length) {
      const operator = tokens[cursor];
      const rank = precedence[operator];
      if (rank === undefined || rank < minimum) break;
      cursor++;
      left = binary(operator, left, expression(rank + (operator === '**' ? 0 : 1)));
    }
    if (minimum === 0 && tokens[cursor] === '?') {
      cursor++;
      const condition = left;
      const yes = expression();
      take(':');
      const no = expression();
      left = (s) => condition(s) ? yes(s) : no(s);
    }
    return left;
  };
  const result = expression();
  if (cursor !== tokens.length) throw new Error(`Unexpected "${tokens[cursor]}"`);
  return result;
}

function compile(source: string): Expression {
  let result = cache.get(source);
  if (!result) {
    try { result = parse(source); }
    catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(source, result);
  }
  if (result instanceof Error) throw result;
  return result;
}

export function numericExpressionError(source: string): string | null {
  if (!source.trim()) return null;
  try { compile(source); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function evaluateExpression(source: string, scope: Scope): number {
  const result = compile(source)(scope);
  if (!Number.isFinite(result)) throw new Error('Formula result must be finite');
  return result;
}
