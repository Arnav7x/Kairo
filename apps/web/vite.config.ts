import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.KAIRO_API_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1/jobs": { target, changeOrigin: true, ws: true },
      "/jobs": { target, changeOrigin: true, ws: true },
      "/v1": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
      "/readyz": { target, changeOrigin: true },
    },
  },
});
