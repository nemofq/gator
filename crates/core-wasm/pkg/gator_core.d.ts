/* tslint:disable */
/* eslint-disable */

/**
 * See `gator_core::Index`. Build one per isolate and reuse it.
 */
export class Index {
    free(): void;
    [Symbol.dispose](): void;
    describe(id: string): string;
    constructor(state: string);
    prepare_call(id: string, _arguments: string): string;
    search(query: string, provider: string | null | undefined, limit: number): string;
}

/**
 * See `gator_core::diff_tools`.
 */
export function diff_tools(input: string): string;

/**
 * Returns the problems with a provider manifest as `[{"path", "message"}]`; empty if it is valid.
 */
export function validate_provider(manifest: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_index_free: (a: number, b: number) => void;
    readonly diff_tools: (a: number, b: number) => [number, number, number, number];
    readonly index_describe: (a: number, b: number, c: number) => [number, number];
    readonly index_new: (a: number, b: number) => [number, number, number];
    readonly index_prepare_call: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly index_search: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly validate_provider: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
