import { describe, expect, it } from 'vitest';
import { evaluateExpression, numericExpressionError } from '../lib/numericExpression';
import { evaluateNumericFormula } from '../components/display/formulaUtils';

describe('restricted numeric expressions', () => {
  it('preserves arithmetic, named columns, Math functions and precedence', () => {
    expect(evaluateExpression('Torque * RPM * 2 * Math.PI / 60', { Torque: 2, RPM: 60 })).toBeCloseTo(4 * Math.PI);
    expect(evaluateExpression('Math.max(1, abs(-x)) + 2 ** 3 ** 2', { x: 4 })).toBe(516);
    expect(evaluateExpression('x > 0 ? sqrt(x) : missing', { x: 9 })).toBe(3);
    expect(evaluateExpression('(0xff & x) >>> 1', { x: 15 })).toBe(7);
    expect(evaluateExpression('温度 * 1e-2', { 温度: 1200 })).toBe(12);
  });
  it.each([
    '(globalThis.__audit = 42, x)', 'window.alert(1)', 'x.constructor.constructor("return 1")()',
    'Math.constructor(1)', '({a: 1}).a', 'Math.random()', '(() => { while(true) {} })()',
    'x[0]', 'x; 1', '__proto__', 'document', '1 /* comment */ + 2',
  ])('rejects executable or ambient syntax: %s', (formula) => {
    expect(numericExpressionError(formula)).not.toBeNull();
    expect(evaluateNumericFormula(7, formula)).toBe(7);
  });
  it('bounds complexity and rejects missing variables and nonfinite results', () => {
    expect(numericExpressionError('('.repeat(300) + '1' + ')'.repeat(300))).not.toBeNull();
    expect(evaluateNumericFormula(7, '1 / 0')).toBe(7);
    expect(evaluateNumericFormula(7, 'missing + 1')).toBe(7);
    expect(evaluateNumericFormula(7, 'x + 1', { x: 99 })).toBe(8);
  });
});
