import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, appRoot, "VITE_");
  const appEnvironment = env.VITE_APP_ENV ?? (mode === "development" ? "local" : "event");
  const termsVersion = env.VITE_TERMS_VERSION ?? (appEnvironment === "local" ? "event-demo-1" : "");
  return {
  root: appRoot,
  base: "/",
  publicDir: false,
  define: {
    "import.meta.env.VITE_TERMS_VERSION": JSON.stringify(termsVersion),
    "import.meta.env.VITE_APP_ENV": JSON.stringify(appEnvironment),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("index.html", import.meta.url)),
    },
  },
  };
});
