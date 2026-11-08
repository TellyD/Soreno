/// <reference types="vite/client" />

// Missing from TypeScript's DOM lib; supported by WebView2, WebKit and Firefox.
interface FocusOptions {
  focusVisible?: boolean;
}
