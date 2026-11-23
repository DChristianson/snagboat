// A small JSON Schema checker for the unit tests: the subset Snagboat's record schemas use.
// Not a test file itself (runUnit.js runs only *.unit.test.js).

export type Schema = Record<string, any>;

/** Validates the subset of JSON Schema the record schemas use, $ref to $defs included; returns the problems found. */
export function validate(schema: Schema, value: unknown, at = '$', root: Schema = schema): string[] {
  const problems: string[] = [];
  if (schema.$ref) {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    if (!name || !root.$defs?.[name]) return [`${at}: unresolved ${schema.$ref}`];
    return validate(root.$defs[name], value, at, root);
  }
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) problems.push(`${at}: does not match ${schema.pattern}`);
  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) problems.push(`${at}: expected ${schema.type}, got ${actual}`);
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => problems.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => validate(s, value, at, root).length === 0)) problems.push(`${at}: matches none of anyOf`);
  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validate(sub, v, `${at}.${key}`, root));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: not in schema`);
      else if (typeof schema.additionalProperties === 'object') problems.push(...validate(schema.additionalProperties, v, `${at}.${key}`, root));
    }
  }
  return problems;
}
