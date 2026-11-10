export const HTTP_LIMIT = 1024 * 1024;
/**
 * Default total bytes of one preview response. Memory is bounded separately by
 * the in-flight window, so this only guards runaway responses; framework dev
 * servers routinely serve bundles above 8 MiB (Next's is 13.26 MB).
 */
export const HTTP_RESPONSE_LIMIT = 64 * 1024 * 1024;
