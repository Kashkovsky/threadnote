/**
 * A total, locale-independent order over JavaScript strings.
 *
 * JavaScript relational string comparison is specified as lexicographic UTF-16
 * code-unit order. It is both locale independent and valid for lone surrogates.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Locale-independent natural order with ASCII digit runs compared by numeric
 * magnitude. Distinct spellings of the same number use code-unit order only as
 * a final tie-break, making the result total without losing natural ordering.
 */
export function compareNaturalCodeUnits(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodeUnit = left.charCodeAt(leftIndex);
    const rightCodeUnit = right.charCodeAt(rightIndex);
    const leftIsDigit = isAsciiDigit(leftCodeUnit);
    const rightIsDigit = isAsciiDigit(rightCodeUnit);

    if (leftIsDigit && rightIsDigit) {
      const leftRunEnd = digitRunEnd(left, leftIndex);
      const rightRunEnd = digitRunEnd(right, rightIndex);
      const leftSignificantStart = significantDigitStart(left, leftIndex, leftRunEnd);
      const rightSignificantStart = significantDigitStart(right, rightIndex, rightRunEnd);
      const leftSignificantLength = leftRunEnd - leftSignificantStart;
      const rightSignificantLength = rightRunEnd - rightSignificantStart;

      if (leftSignificantLength !== rightSignificantLength) {
        return leftSignificantLength < rightSignificantLength ? -1 : 1;
      }
      for (let offset = 0; offset < leftSignificantLength; offset += 1) {
        const difference =
          left.charCodeAt(leftSignificantStart + offset) - right.charCodeAt(rightSignificantStart + offset);
        if (difference !== 0) return difference < 0 ? -1 : 1;
      }

      leftIndex = leftRunEnd;
      rightIndex = rightRunEnd;
      continue;
    }

    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit < rightCodeUnit ? -1 : 1;
    leftIndex += 1;
    rightIndex += 1;
  }

  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return compareCodeUnits(left, right);
}

function digitRunEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && isAsciiDigit(value.charCodeAt(end))) end += 1;
  return end;
}

function significantDigitStart(value: string, start: number, end: number): number {
  let significantStart = start;
  while (significantStart + 1 < end && value.charCodeAt(significantStart) === 0x30) significantStart += 1;
  return significantStart;
}

function isAsciiDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}
