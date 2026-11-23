import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "ui",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
