import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";

const directories = new AsyncLocalStorage<string>();
export function getWorkspaceDirectory(): string {
  return directories.getStore() ?? process.cwd();
}
export function withWorkspace<T>(directory: string, run: () => T): T {
  if (!isAbsolute(directory)) throw new Error("Cursor workspace must be an absolute path");
  return directories.run(directory, run);
}
