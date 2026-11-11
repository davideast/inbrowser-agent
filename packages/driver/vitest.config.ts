import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /.*\/preload\/export\.js$/,
        replacement: new URL('./dist/preload.js', import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ['tests/unit/**/*.unit.test.ts'],
  },
});
