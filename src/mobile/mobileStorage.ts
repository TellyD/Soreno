export function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing may refuse storage: the value then lasts for the page only.
  }
}

const TOOLS_HIDDEN_KEY = "soreno-mobile-tools-hidden";

/** Whether conversations leave out tool calls: one choice for every session. */
export function loadToolsHidden() {
  return readStorage(TOOLS_HIDDEN_KEY) === "1";
}

export function saveToolsHidden(hidden: boolean) {
  writeStorage(TOOLS_HIDDEN_KEY, hidden ? "1" : "0");
}
