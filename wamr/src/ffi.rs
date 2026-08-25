//! Minimal bindings to WAMR's stable embedding surface (`wasm_export.h`).
//!
//! Keeping this list handwritten avoids a bindgen/libclang build dependency.

use std::ffi::{c_char, c_void};

pub type WasmModule = *mut c_void;
pub type WasmModuleInst = *mut c_void;
pub type WasmExecEnv = *mut c_void;
pub type WasmFunctionInst = *mut c_void;
pub type WasmMemoryInst = *mut c_void;

pub const WASM_I32: u8 = 0;

#[repr(C)]
pub struct NativeSymbol {
    pub symbol: *const c_char,
    pub func_ptr: *mut c_void,
    pub signature: *const c_char,
    pub attachment: *mut c_void,
}

#[repr(C)]
pub struct WasmGlobalInst {
    pub kind: u8,
    pub is_mutable: bool,
    pub global_data: *mut c_void,
}

extern "C" {
    pub fn wasm_runtime_init() -> bool;
    pub fn wasm_runtime_destroy();

    pub fn wasm_runtime_register_natives(
        module_name: *const c_char,
        native_symbols: *mut NativeSymbol,
        n_native_symbols: u32,
    ) -> bool;

    pub fn wasm_runtime_load(
        buf: *mut u8,
        size: u32,
        error_buf: *mut c_char,
        error_buf_size: u32,
    ) -> WasmModule;
    pub fn wasm_runtime_unload(module: WasmModule);
    pub fn wasm_runtime_instantiate(
        module: WasmModule,
        default_stack_size: u32,
        host_managed_heap_size: u32,
        error_buf: *mut c_char,
        error_buf_size: u32,
    ) -> WasmModuleInst;
    pub fn wasm_runtime_deinstantiate(module_inst: WasmModuleInst);

    pub fn wasm_runtime_create_exec_env(
        module_inst: WasmModuleInst,
        stack_size: u32,
    ) -> WasmExecEnv;
    pub fn wasm_runtime_destroy_exec_env(exec_env: WasmExecEnv);
    pub fn wasm_runtime_get_module_inst(exec_env: WasmExecEnv) -> WasmModuleInst;

    pub fn wasm_runtime_lookup_function(
        module_inst: WasmModuleInst,
        name: *const c_char,
    ) -> WasmFunctionInst;
    pub fn wasm_runtime_call_wasm(
        exec_env: WasmExecEnv,
        function: WasmFunctionInst,
        argc: u32,
        argv: *mut u32,
    ) -> bool;
    pub fn wasm_runtime_get_exception(module_inst: WasmModuleInst) -> *const c_char;

    pub fn wasm_runtime_set_custom_data(module_inst: WasmModuleInst, custom_data: *mut c_void);
    pub fn wasm_runtime_get_custom_data(module_inst: WasmModuleInst) -> *mut c_void;

    pub fn wasm_runtime_get_memory(module_inst: WasmModuleInst, index: u32) -> WasmMemoryInst;
    pub fn wasm_memory_get_cur_page_count(memory_inst: WasmMemoryInst) -> u64;
    pub fn wasm_memory_get_bytes_per_page(memory_inst: WasmMemoryInst) -> u64;
    pub fn wasm_memory_get_base_address(memory_inst: WasmMemoryInst) -> *mut c_void;
    pub fn wasm_memory_enlarge(memory_inst: WasmMemoryInst, inc_page_count: u64) -> bool;

    pub fn wasm_runtime_get_export_global_inst(
        module_inst: WasmModuleInst,
        name: *const c_char,
        global_inst: *mut WasmGlobalInst,
    ) -> bool;
}
