import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * Two projects:
 *   engine — pure algorithm code, node environment, no DOM setup. Fast.
 *   ui     — components/pages/hooks, jsdom + testing-library setup.
 *
 * Run one with `npm run test:engine` / `npm run test:ui`, or `--project engine`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "engine",
          environment: "node",
          setupFiles: [],
          include: ["src/{engine,services}/**/*.{test,spec}.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/{components,pages,hooks,test}/**/*.{test,spec}.{ts,tsx}"],
        },
      },
    ],
  },
});
