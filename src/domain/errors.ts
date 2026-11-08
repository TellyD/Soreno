export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const summary = `${error.name}: ${error.message}`;
    if (!error.stack) return summary;
    // WebKit stacks list only frames; V8 stacks start with the summary.
    return error.stack.startsWith(summary)
      ? error.stack
      : `${summary}\n${error.stack}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
