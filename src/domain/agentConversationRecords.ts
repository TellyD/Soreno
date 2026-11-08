export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const text = (value: unknown) =>
  typeof value === "string" ? value : "";
export const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
