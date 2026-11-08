type LongTasks = { count: number; total: number; max: number };

// undefined: not started yet; null: the webview has no long task entries (WebKit).
let longTasks: LongTasks | null | undefined;

function observeLongTasks() {
  if (longTasks !== undefined) return longTasks;
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  )
    return (longTasks = null);
  const tasks: LongTasks = { count: 0, total: 0, max: 0 };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      tasks.count++;
      tasks.total += entry.duration;
      tasks.max = Math.max(tasks.max, entry.duration);
    }
  }).observe({ type: "longtask" });
  return (longTasks = tasks);
}

/**
 * Tasks of 50 ms or more that blocked the whole webview since the previous call (shared by
 * every terminal), and the JS heap in use (Chromium only).
 */
export function takeMainThreadStats() {
  const tasks = observeLongTasks();
  const taken = tasks ? { ...tasks } : null;
  if (tasks) Object.assign(tasks, { count: 0, total: 0, max: 0 });
  const heap = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory?.usedJSHeapSize;
  return {
    longTasks: taken,
    heapMb: heap === undefined ? null : heap / 1048576,
  };
}
