/**
 * Minified self-contained IIFE preload script to inject into a guest document
 * before guest scripts execute.
 *
 * Populated at build time into `dist/preload.js` (and bundled into `dist/index.js`)
 * by `scripts/build.mjs`. Initialized with a typed placeholder so unbundled TypeScript
 * loaders (e.g. Playwright's Node TS loader) see a valid ESM binding.
 */
export const DRIVER_PRELOAD_SOURCE: string = '';

/** UTF-8 byte length of {@link DRIVER_PRELOAD_SOURCE} (`<= 45_056` bytes minified, `<= 16_384` bytes gzipped). */
export const DRIVER_PRELOAD_BYTE_LENGTH: number = 0;
