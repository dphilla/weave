//! Narrow, checked adaptations of the pinned WAMR sources, generated only in
//! Cargo's build directory. The external verified checkout is never modified.
// WAMR C fragments: Copyright (C) 2019 Intel Corporation.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
use std::fs;
use std::path::Path;

fn replace(source: &mut String, before: &str, after: &str, count: usize) {
    assert_eq!(
        source.matches(before).count(),
        count,
        "pinned WAMR compatibility patch no longer matches: {before}"
    );
    *source = source.replace(before, after);
}

fn section(source: &mut String, begin: &str, end: &str, edit: impl FnOnce(&mut String)) {
    let start = source
        .find(begin)
        .expect("missing pinned WAMR section start");
    let finish = start
        + source[start..]
            .find(end)
            .expect("missing pinned WAMR section end");
    let mut body = source[start..finish].to_owned();
    edit(&mut body);
    source.replace_range(start..finish, &body);
}

pub fn prepare(root: &Path, out: &Path) {
    fs::create_dir_all(out).expect("create WAMR compatibility directory");
    let interpreter = root.join("core/iwasm/interpreter");
    let mut runtime = fs::read_to_string(interpreter.join("wasm_runtime.c")).unwrap();
    section(
        &mut runtime,
        "static bool\nexecute_post_instantiate_functions(",
        "\n}\n",
        |body| {
            let signature_end = body.find('{').expect("constructor hook body");
            body.truncate(signature_end + 1);
            body.push_str("\n    /* Weave starts exports explicitly; restoring must execute no guest code. */\n    (void)module_inst;\n    (void)is_sub_inst;\n    (void)exec_env_main;\n    return true;");
        },
    );
    fs::write(out.join("wasm_runtime.c"), runtime).unwrap();

    let mut loader = fs::read_to_string(interpreter.join("wasm_loader.c")).unwrap();
    // SIMD memargs have the same optional memory index as scalar memargs.
    section(
        &mut loader,
        "case WASM_OP_SIMD_PREFIX:\n            {\n                uint32 opcode1;",
        "#endif /* end of WASM_ENABLE_SIMD */",
        |simd| {
            replace(
                simd,
                "skip_leb_uint32(p, p_end);",
                "skip_leb_align(p, p_end);",
                3,
            );
        },
    );
    section(
        &mut loader,
        "{\n    uint8 *p = func->code, *p_end = func->code + func->code_size, *p_org;",
        "\nfail:\n",
        |prepare| {
            replace(
                prepare,
                "pb_read_leb_uint32(p, p_end, align);",
                "pb_read_leb_memarg(p, p_end, align);",
                5,
            );
            replace(
                prepare,
                "pb_read_leb_memarg(p, p_end, align);",
                "memidx = 0;\n                pb_read_leb_memarg(p, p_end, align);",
                6,
            );
            replace(prepare, "emit_uint32(loader_ctx, mem_offset);", "emit_uint32(loader_ctx, memidx);\n                emit_uint32(loader_ctx, mem_offset);", 6);
            section(
                prepare,
                "            case WASM_OP_MEMORY_SIZE:",
                "            case WASM_OP_I32_CONST:",
                |sizes| {
                    replace(sizes, "check_memidx(module, memidx);", "check_memidx(module, memidx);\n#if WASM_ENABLE_FAST_INTERP != 0\n                emit_uint32(loader_ctx, memidx);\n#endif", 2);
                },
            );
            section(
                prepare,
                "                    case WASM_OP_MEMORY_INIT:",
                "                    fail_unknown_memory:",
                |bulk| {
                    replace(bulk, "check_memidx(module, memidx);", "check_memidx(module, memidx);\n#if WASM_ENABLE_FAST_INTERP != 0\n                        emit_uint32(loader_ctx, memidx);\n#endif", 4);
                },
            );
        },
    );
    fs::write(out.join("wasm_loader.c"), loader).unwrap();

    let mut fast = fs::read_to_string(interpreter.join("wasm_interp_fast.c")).unwrap();
    replace(
        &mut fast,
        "typedef int32 CellType_I32;",
        r#"/* Every memory opcode carries a validated memory index in fast bytecode.
 * Refresh the bounds whenever the selected memory changes. */
#define WEAVE_READ_MEMORY() \
    ((memory = module->memories[read_uint32(frame_ip)]), \
     (linear_mem_size = GET_LINEAR_MEMORY_SIZE(memory)), memory)

typedef int32 CellType_I32;"#,
        1,
    );
    replace(
        &mut fast,
        "offset = read_uint32(frame_ip);",
        "offset = (WEAVE_READ_MEMORY(), read_uint32(frame_ip));",
        27,
    );
    section(
        &mut fast,
        "            HANDLE_OP(WASM_OP_MEMORY_SIZE)",
        "            /* constant instructions */",
        |sizes| {
            *sizes = r#"            HANDLE_OP(WASM_OP_MEMORY_SIZE)
            {
                WEAVE_READ_MEMORY();
                addr_ret = GET_OFFSET();
                frame_lp[addr_ret] = memory->cur_page_count;
                HANDLE_OP_END();
            }

            HANDLE_OP(WASM_OP_MEMORY_GROW)
            {
                uint32 mem_idx = read_uint32(frame_ip);
                uint32 delta, prev_page_count;
                memory = module->memories[mem_idx];
                prev_page_count = memory->cur_page_count;
                addr1 = GET_OFFSET();
                addr_ret = GET_OFFSET();
                delta = (uint32)frame_lp[addr1];
                frame_lp[addr_ret] = wasm_enlarge_memory_with_idx(module, delta, mem_idx)
                    ? prev_page_count : (uint32)-1;
                linear_mem_size = GET_LINEAR_MEMORY_SIZE(memory);
                HANDLE_OP_END();
            }

"#
            .to_owned();
        },
    );
    section(
        &mut fast,
        "                    case WASM_OP_MEMORY_INIT:",
        "                    case WASM_OP_DATA_DROP:",
        |init| {
            replace(
                init,
                "segment = read_uint32(frame_ip);",
                "segment = read_uint32(frame_ip);\n                        WEAVE_READ_MEMORY();",
                1,
            );
        },
    );
    section(
        &mut fast,
        "                    case WASM_OP_MEMORY_COPY:",
        "                    case WASM_OP_MEMORY_FILL:",
        |copy| {
            *copy = r#"                    case WASM_OP_MEMORY_COPY:
                    {
                        uint32 dst_idx = read_uint32(frame_ip);
                        uint32 src_idx = read_uint32(frame_ip);
                        uint32 len = POP_I32();
                        uint32 src = POP_I32();
                        uint32 dst = POP_I32();
                        WASMMemoryInstance *dst_mem = module->memories[dst_idx];
                        WASMMemoryInstance *src_mem = module->memories[src_idx];
                        if ((uint64)src + len > GET_LINEAR_MEMORY_SIZE(src_mem)
                            || (uint64)dst + len > GET_LINEAR_MEMORY_SIZE(dst_mem))
                            goto out_of_bounds;
                        if (len)
                            memmove(dst_mem->memory_data + dst,
                                    src_mem->memory_data + src, len);
                        break;
                    }
"#
            .to_owned();
        },
    );
    section(
        &mut fast,
        "                    case WASM_OP_MEMORY_FILL:",
        "#endif /* WASM_ENABLE_BULK_MEMORY */",
        |fill| {
            replace(
                fill,
                "len = POP_I32();",
                "WEAVE_READ_MEMORY();\n                        len = POP_I32();",
                1,
            );
        },
    );
    fs::write(out.join("wasm_interp_fast.c"), fast).unwrap();
}
