import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { registerCursorNative } from "./index.js";

export default function cursorNative(pi: ExtensionAPI): void {
  registerCursorNative(pi, { compatRegistry: { getApiProvider, registerApiProvider } });
}
