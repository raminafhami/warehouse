import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { PORT = "4000" } = loadEnv(mode, root, ["PORT"]);
  return {
    plugins: [react()],
    server: { proxy: { "/api": `http://127.0.0.1:${PORT}` } },
  };
});
