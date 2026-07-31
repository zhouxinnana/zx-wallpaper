import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist-electron",
    emptyOutDir: true,
    lib: {
      entry: "electron/main.ts",
      formats: ["es"],
      fileName: "main",
    },
    rollupOptions: {
      external: ["electron", "wallpaper", "chokidar", /^node:/],
    },
  },
});
