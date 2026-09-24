import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs run separately (pnpm e2e).
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/e2e/**'],
    coverage: {
      provider: 'v8',
      // The gate covers the domain logic, where correctness matters most (engineering §4).
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/core/src/test-builders.ts', 'packages/core/src/index.ts'],
      reporter: ['text-summary', 'text'],
      // The plan's gate is 90 %; branches have a lower floor so they can't slip while they catch up.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
