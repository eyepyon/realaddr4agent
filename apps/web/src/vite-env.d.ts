/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TERMS_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
