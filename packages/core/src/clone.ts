/** Deep copy of plain JSON data (documents are always serializable). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
