// Compiled sources travel through MessagePorts, not the fixed-size syscall slot.
// Nothing sizes a buffer from these: a source is held as a string and measured
// when it is published or served, so a larger bound costs memory only when a
// module of that size exists. The aggregate keeps the 4:1 ratio to the
// per-module bound: one maximum-size module plus 96 MiB of other framework code.
export const MODULE_SOURCE_LIMIT = 32 * 1024 * 1024;
export const MODULE_TOTAL_LIMIT = 128 * 1024 * 1024;
