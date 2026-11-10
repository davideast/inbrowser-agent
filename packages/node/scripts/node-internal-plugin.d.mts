import type { Plugin } from 'esbuild';

export declare const HOST_BUNDLE_ALIAS: Record<string, string>;
export declare const PROCESS_BUNDLE_ALIAS: Record<string, string>;
export declare function createNodeInternalPlugin(projectRoot?: string): Plugin;
