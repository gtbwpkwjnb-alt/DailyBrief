import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  use: {
    browserName: "chromium",
    headless: true,
  },
});
