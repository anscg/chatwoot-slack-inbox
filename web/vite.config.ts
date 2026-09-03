import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // In dev, the API/auth routes live on the Node server.
    proxy: { "/admin/api": "http://localhost:3000", "/admin/login": "http://localhost:3000", "/admin/logout": "http://localhost:3000", "/admin/callback": "http://localhost:3000" },
  },
});
