import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // PORT lets a supervisor (preview harness, container, CI) place the dev
  // server somewhere free; 5173 stays the default for a plain `npm run dev`.
  server: { port: Number(process.env.PORT) || 5173, open: true },
});
