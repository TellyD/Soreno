// jsdom has no layout API for text ranges. Tests still use real CodeMirror views.
export function stubEditorGeometry(): () => void {
  const restore: (() => void)[] = [];
  for (const name of ["getClientRects", "getBoundingClientRect"] as const) {
    if (typeof Range.prototype[name] === "function") continue;
    const previous = Object.getOwnPropertyDescriptor(Range.prototype, name);
    Object.defineProperty(Range.prototype, name, {
      configurable: true,
      value: () =>
        name === "getClientRects"
          ? Object.assign([], { item: () => null })
          : new DOMRect(),
    });
    restore.push(() => {
      if (previous) Object.defineProperty(Range.prototype, name, previous);
      else Reflect.deleteProperty(Range.prototype, name);
    });
  }
  return () => restore.forEach((reset) => reset());
}
