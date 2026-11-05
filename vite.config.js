import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/frontend/**/*.{test,spec}.{js,jsx}"],
    clearMocks: true,
  },
});
