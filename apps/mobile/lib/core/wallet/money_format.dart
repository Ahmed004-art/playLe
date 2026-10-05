/// Formats a decimal string of integer minor units (e.g. `"50000"`) as a
/// display string (e.g. `"Le 500.00"`). Uses [BigInt] arithmetic
/// throughout — never a `double` — consistent with the "money is always
/// an integer, never a float" rule that applies on the server too (see
/// docs/decisions/ADR-012-financial-architecture.md). Display-only: no
/// screen does math on the formatted string.
String formatMinorAmount(String minorUnitsString, {String currency = 'SLE'}) {
  final minor = BigInt.parse(minorUnitsString);
  final isNegative = minor.isNegative;
  final abs = minor.abs();
  final hundred = BigInt.from(100);
  final major = abs ~/ hundred;
  final cents = (abs % hundred).toString().padLeft(2, '0');
  final sign = isNegative ? '-' : '';
  final symbol = currency == 'SLE' ? 'Le' : currency;
  return '$sign$symbol $major.$cents';
}
