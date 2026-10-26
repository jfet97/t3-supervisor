const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeJson = (value: unknown, depth = 0, maxDepth = 64): unknown => {
  if (depth > maxDepth) throw new Error("json_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, depth + 1, maxDepth));
  if (!isRecord(value)) throw new Error("json_value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("json_prototype");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], depth + 1, maxDepth);
  return result;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value));

/**
 * The canonical JSON of plain data as it is stored: what a JSON round trip drops is dropped first, then keys are sorted, so a schema
 * decode that reorders an object's keys never changes it while every value, array position and identifier still does. maxDepth is the
 * deepest nesting the stored value's own validation allows.
 */
export const canonicalStoredJson = (value: unknown, maxDepth: number): string =>
  JSON.stringify(normalizeJson(JSON.parse(JSON.stringify(value) ?? "null"), 0, maxDepth));
