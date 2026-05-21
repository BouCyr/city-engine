export function cloneDeepKeepFunctions(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const arr = [];
    seen.set(value, arr);
    for (const item of value) arr.push(cloneDeepKeepFunctions(item, seen));
    return arr;
  }

  if (value instanceof Set) {
    const set = new Set();
    seen.set(value, set);
    for (const item of value) set.add(cloneDeepKeepFunctions(item, seen));
    return set;
  }

  const clone = Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    clone[key] = cloneDeepKeepFunctions(value[key], seen);
  }

  return clone;
}
