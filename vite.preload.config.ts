import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-electron",
    emptyOutDir: false,
    lib: {
      entry: "electron/preload.ts",
      formats: ["cjs"],
      fileName: "preload",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
});
