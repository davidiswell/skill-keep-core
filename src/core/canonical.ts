/** Deterministic JSON for Skill Keep signatures; this is an application format, not a claim of RFC 8785 conformance. */
export function canonicalJson(value: unknown): string {
  const pieces: string[] = [];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 2_000_000) throw new Error('The signed document is too large.');
    pieces.push(text);
  };
  const write = (input: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 32) throw new Error('The signed document is too complex.');
    if (input === null) { append('null'); return; }
    if (typeof input === 'string') {
      if (input.length > 2_000_000) throw new Error('The signed document is too large.');
      append(JSON.stringify(input)); return;
    }
    if (typeof input === 'boolean') { append(input ? 'true' : 'false'); return; }
    if (typeof input === 'number' && Number.isFinite(input)) { append(JSON.stringify(input)); return; }
    if (!input || typeof input !== 'object') throw new Error('The signed document must contain only JSON values.');
    if (seen.has(input)) throw new Error('The signed document contains a circular reference.');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > 20000) throw new Error('The signed document is too complex.');
        if (Object.getOwnPropertySymbols(input).length || Object.getOwnPropertyNames(input).some(key => key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))) throw new Error('The signed document contains non-JSON array properties.');
        append('[');
        for (let index = 0; index < input.length; index++) {
          if (!Object.hasOwn(input, index)) throw new Error('The signed document contains an empty array item.');
          const descriptor = Object.getOwnPropertyDescriptor(input, index);
          if (!descriptor || !('value' in descriptor)) throw new Error('The signed document must not contain accessor properties.');
          if (index) append(','); write(descriptor.value, depth + 1);
        }
        append(']'); return;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('The signed document must contain plain JSON objects.');
      const keys = Object.keys(input).sort();
      if (keys.length > 20000 || Object.getOwnPropertySymbols(input).length) throw new Error('The signed document is too complex.');
      if (Object.getOwnPropertyNames(input).length !== keys.length) throw new Error('The signed document contains non-JSON object properties.');
      append('{');
      keys.forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('The signed document must not contain accessor properties.');
        if (index) append(','); append(JSON.stringify(key)); append(':'); write(descriptor.value, depth + 1);
      });
      append('}');
    } finally { seen.delete(input); }
  };
  write(value, 0);
  return pieces.join('');
}
