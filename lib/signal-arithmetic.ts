export const ARITHMETIC_SYMBOLS = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
} as const;

export type ArithmeticOperation = keyof typeof ARITHMETIC_SYMBOLS;

export function isArithmetic(
  operation: string,
): operation is ArithmeticOperation {
  return Object.hasOwn(ARITHMETIC_SYMBOLS, operation);
}

// Keep old workspace recipes executable, but do not offer them in the palette.
export function isBinaryOperation(operation: string) {
  return (
    isArithmetic(operation) || operation === 'power' || operation === 'bsfc'
  );
}

export function arithmeticValue(
  operation: ArithmeticOperation,
  a: number,
  b: number,
) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  let result: number;
  switch (operation) {
    case 'add':
      result = a + b;
      break;
    case 'subtract':
      result = a - b;
      break;
    case 'multiply':
      result = a * b;
      break;
    case 'divide':
      result = b === 0 ? NaN : a / b;
      break;
  }
  return Number.isFinite(result) ? result : NaN;
}

export function arithmeticUnit(
  operation: ArithmeticOperation,
  first: string,
  second: string,
) {
  const a = first.trim();
  const b = second.trim();
  if (operation === 'add' || operation === 'subtract') {
    if (a !== b)
      throw new Error(
        'Add and subtract require matching unit labels. Convert the inputs to the same units first.',
      );
    return a;
  }
  const factor = (unit: string) => (/[·×/]/.test(unit) ? `(${unit})` : unit);
  if (operation === 'multiply') {
    if (!a || a === '1') return b;
    if (!b || b === '1') return a;
    return `${factor(a)}·${factor(b)}`;
  }
  if (a === b) return '1';
  if (!b || b === '1') return a;
  return `${a ? factor(a) : '1'}/${factor(b)}`;
}
