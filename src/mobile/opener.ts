// Replaces `@tauri-apps/plugin-opener` in the mobile page (vite.mobile.config.ts): `MarkdownContent` opens links through it.
export async function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}
