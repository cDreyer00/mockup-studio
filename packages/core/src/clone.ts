/** Cópia profunda de dados JSON puros (documentos são sempre serializáveis). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
