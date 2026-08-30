// Fixed-size C array/table length guard.
//
// Several ported tables are hand-maintained literals that must carry an exact
// row count to match a C array declaration (e.g. `float foo[16][256]`) or a
// protocol-sized buffer (e.g. a 1024-byte lookup table). C enforces this at
// compile time via the array bound; TypeScript literals do not, so a future
// edit that drops or duplicates a row/byte would only surface as a runtime
// crash or protocol corruption far from the table itself. Wrapping a table's
// initializer in fixedLength(...) makes a length slip fail loudly at module
// load (effectively at boot) instead of mid-game.
export function fixedLength<T extends { length: number }>(name: string, expected: number, value: T): T {
  if (value.length !== expected) {
    throw new Error(`${name}: ${value.length} elements, expected ${expected}`);
  }
  return value;
}
