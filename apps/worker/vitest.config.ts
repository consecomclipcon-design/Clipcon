import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { APP_SECRET: 'test-secret' },
    passWithNoTests: true,
  },
});