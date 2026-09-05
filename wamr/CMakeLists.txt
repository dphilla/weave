cmake_minimum_required(VERSION 3.14)
project(weave_wamr_vmlib C ASM)

if(NOT DEFINED WAMR_ROOT_DIR)
  message(FATAL_ERROR "Pass -DWAMR_ROOT_DIR=/path/to/wasm-micro-runtime")
endif()

string(TOLOWER "${CMAKE_HOST_SYSTEM_NAME}" WAMR_BUILD_PLATFORM)
if(APPLE)
  add_definitions(-DBH_PLATFORM_DARWIN)
endif()

if(NOT DEFINED WAMR_BUILD_TARGET)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64)")
    set(WAMR_BUILD_TARGET "AARCH64")
  elseif(CMAKE_SYSTEM_PROCESSOR STREQUAL "riscv64")
    set(WAMR_BUILD_TARGET "RISCV64")
  elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(WAMR_BUILD_TARGET "X86_64")
  elseif(CMAKE_SIZEOF_VOID_P EQUAL 4)
    set(WAMR_BUILD_TARGET "X86_32")
  else()
    message(FATAL_ERROR "Unsupported WAMR target")
  endif()
endif()

# Browser peers send portable Wasm, so the interpreter is the required engine.
# Enable every proposal currently accepted by the Weave transformer.
set(WAMR_BUILD_INTERP 1)
# Fast interpretation plus SIMDe executes SIMD without an LLVM dependency.
# Build-local compatibility sources preserve indexed multi-memory operations.
set(WAMR_BUILD_FAST_INTERP 1)
set(WAMR_BUILD_LIB_SIMDE 1)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)
set(WAMR_BUILD_LIBC_BUILTIN 0)
set(WAMR_BUILD_LIBC_WASI 0)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_SIMD 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_MULTI_MEMORY 1)
set(WAMR_BUILD_MEMORY64 0)
set(WAMR_BUILD_SHARED_MEMORY 0)
set(WAMR_BUILD_MULTI_MODULE 0)
# Use explicit memory bounds for every indexed memory on all platforms.
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
# WAMR's Darwin hardware stack setup walks to the pthread guard with alloca,
# which collides with Rust's own main-thread guard before WAMR installs its
# signal handler. The interpreter retains its explicit Wasm operand/call-stack
# bounds checks; only this native guard-page optimization is disabled.
if(APPLE)
  set(WAMR_DISABLE_STACK_HW_BOUND_CHECK 1)
endif()

# FetchContent honors the first declaration; override WAMR's movable v0.8.2
# tag with that release's immutable commit before its SIMDe setup runs.
include(FetchContent)
FetchContent_Declare(simde
  GIT_REPOSITORY https://github.com/simd-everywhere/simde.git
  GIT_TAG 71fd833d9666141edcd1d3c109a80e228303d8d7)
include("${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake")

foreach(source wasm_runtime.c wasm_loader.c wasm_interp_fast.c)
  list(REMOVE_ITEM WAMR_RUNTIME_LIB_SOURCE "${WAMR_ROOT_DIR}/core/iwasm/interpreter/${source}")
  list(APPEND WAMR_RUNTIME_LIB_SOURCE "${WEAVE_WAMR_COMPAT_DIR}/${source}")
endforeach()

add_library(weave_wamr_vmlib STATIC ${WAMR_RUNTIME_LIB_SOURCE})
target_include_directories(weave_wamr_vmlib PRIVATE "${WAMR_ROOT_DIR}/core/iwasm/interpreter")
set_target_properties(weave_wamr_vmlib PROPERTIES POSITION_INDEPENDENT_CODE ON)
install(TARGETS weave_wamr_vmlib ARCHIVE DESTINATION lib)
