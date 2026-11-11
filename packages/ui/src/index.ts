import { INDEX_HTML, MANIFEST } from "./page.js";
import { APP_JS } from "./script.js";
import { APP_CSS } from "./style.js";

/** One file the web chat serves. */
export interface WebChatAsset { readonly type: string; readonly body: string }

/**
 * The files of the responsive web chat (card U07): the page, its script and style, and the app manifest. They have no dependency and no inline code. Give them to the controller's `webChat`
 * start option as `assets`; the controller serves them without a session and everything else behind the owner's sign-in.
 */
export function webChatAssets(): Readonly<Record<string, WebChatAsset>> {
  return {
    "/": { type: "text/html; charset=utf-8", body: INDEX_HTML },
    "/app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
    "/app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
    "/manifest.webmanifest": { type: "application/manifest+json", body: MANIFEST },
  };
}

export { INDEX_HTML, APP_JS, APP_CSS };
