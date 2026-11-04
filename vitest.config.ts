import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 10000, hookTimeout: 15000, maxWorkers: 4 } });
