const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];

// Order matters: most browsers also claim to be Chrome or Safari.
const BROWSERS: [RegExp, string][] = [
  [/EdgiOS|EdgA|Edg\//, "Edge"],
  [/FxiOS|Firefox\//, "Firefox"],
  [/OPiOS|OPR\//, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/** How the server lists this phone, e.g. « iPhone · Safari ». */
export function deviceLabel(userAgent: string, maxTouchPoints: number) {
  const named = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  // iPadOS reports a desktop Mac user agent; only its touch screen tells it apart.
  const system =
    named === "Mac" && maxTouchPoints > 1 ? "iPad" : (named ?? "Navigateur");
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return browser ? `${system} · ${browser}` : system;
}
