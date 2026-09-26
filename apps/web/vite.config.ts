import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { CURRENT_TERMS_VERSION } from "../../packages/domain/src/terms.ts";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, appRoot, "VITE_");
  const appEnvironment = env.VITE_APP_ENV ?? (mode === "development" ? "local" : "event");
  if (appEnvironment !== "local" && appEnvironment !== "event") throw new Error("invalid_web_environment");
  const termsVersion = env.VITE_TERMS_VERSION ?? (appEnvironment === "local" ? "event-demo-1" : "");
  if (appEnvironment === "event" && termsVersion !== CURRENT_TERMS_VERSION) throw new Error("event_terms_version_must_match_current_terms");
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
