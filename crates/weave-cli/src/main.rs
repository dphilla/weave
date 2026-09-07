//! The `weave` command-line tool.
//!
//!   weave transform IN.wasm -o OUT.wasm [--period N] [--stack-pages N]
//!   weave run MODULE --invoke NAME [--arg V]... [--pre-woven]
//!   weave checkpoint MODULE --invoke NAME [--arg V]... --after-polls N -o SNAP
//!   weave restore MODULE SNAP [--pre-woven]
//!   weave serve --listen ADDR [--module M --invoke NAME [--arg V]...]
//!               [--pre-woven] [--exit-on-done]
//!   weave migrate --node ADDR --to ADDR
//!   weave status --node ADDR
//!
//! The built-in host services (`env.emit`, `env.emit32`, `env.emit64`) print
//! progress lines and carry accumulator state that migrates with the
//! workload; they exist so any runner (Rust, Node, Go) exposes an identical,
//! byte-compatible service set.

use anyhow::{anyhow, bail, Context, Result};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use wasmtime::Val;
use weave_core::{Meta, ValType};
use weave_host::HostService;
use weave_transform::TransformOptions;
use weave_wasmtime::instance::LinkFn;
use weave_wasmtime::serve::{serve_with_capabilities, InitialWork, NodeConfig, NodeFactories};
use weave_wasmtime::{default_engine, WeaveInstance, WeaveModule, WorkResult};

mod args;
mod control;
mod inspect;
use args::Args;

#[derive(Debug)]
struct Reported(i32);
impl std::fmt::Display for Reported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "reported failure")
    }
}
impl std::error::Error for Reported {}

#[derive(Debug)]
struct CliError {
    code: &'static str,
    message: String,
    exit: i32,
}
impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CliError {}
fn cli_error(code: &'static str, exit: i32, message: impl Into<String>) -> anyhow::Error {
    CliError {
        code,
        message: message.into(),
        exit,
    }
    .into()
}

fn main() {
    if let Err(e) = run() {
        if let Some(reported) = e.downcast_ref::<Reported>() {
            std::process::exit(reported.0);
        }
        let (code, exit) = e
            .downcast_ref::<CliError>()
            .map(|e| (e.code, e.exit))
            .unwrap_or(("COMMAND_FAILED", 1));
        if std::env::args().any(|a| a == "--json") {
            println!(
                "{}",
                serde_json::json!({"schema_version":1,"ok":false,"code":code,"message":format!("{e:#}"),"retry":"never"})
            );
        } else if code == "COMMAND_FAILED" {
            // Preserve legacy diagnostic prefixes consumed by corpus tooling.
            eprintln!("weave: error: {e:#}");
        } else {
            eprintln!("weave: {code}: {e:#}");
        }
        std::process::exit(exit);
    }
}

fn run() -> Result<()> {
    let mut argv: VecDeque<String> = std::env::args().skip(1).collect();
    let cmd = argv
        .pop_front()
        .ok_or_else(|| cli_error("USAGE_ERROR", 2, USAGE))?;
    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!(
            "{}",
            args::help(argv.front().map(String::as_str).unwrap_or(""))
        );
        return Ok(());
    }
    let args = Args::parse(&cmd, argv).map_err(|e| cli_error("USAGE_ERROR", 2, e.to_string()))?;
    if args.has("help") {
        println!("{}", args::help(&cmd));
        return Ok(());
    }
    match cmd.as_str() {
        "transform" => cmd_transform(&args),
        "run" => cmd_run(&args),
        "checkpoint" => cmd_checkpoint(&args),
        "restore" => cmd_restore(&args),
        "serve" => cmd_serve(&args),
        "inspect" => inspect::run(&args),
        "migrate" | "status" | "operation" => control::run(&cmd, &args),
        other => bail!("unknown command {other}\n{USAGE}"),
    }
}

const USAGE: &str = "usage:
  weave transform IN.wasm -o OUT.wasm [--period N] [--stack-pages N]
  weave run MODULE --invoke NAME [--arg V]... [--pre-woven]
  weave checkpoint MODULE --invoke NAME [--arg V]... --after-polls N -o SNAP [--pre-woven]
  weave restore MODULE SNAP [--pre-woven]
  weave serve --listen ADDR [--module M --invoke NAME [--arg V]...] [--pre-woven] [--exit-on-done]
  weave inspect MODULE [--invoke NAME --arg V ...] [--node ADDR] [--json]
  weave migrate --node ADDR --to ADDR [--operation-id ID --node-epoch EPOCH] [--json]
  weave status --node ADDR [--json]
  weave operation --node ADDR --operation-id ID --node-epoch EPOCH [--wait] [--json]
Use weave COMMAND --help for options. JSON is supported by inspect/status/migrate/operation.
Exit codes: 0 success/accepted; 1 legacy command failure; 2 usage;
3 incompatible/unknown preflight; 4 control failure;
5 commit or delivery uncertain; 6 wait expired (not proof of failure).";

fn transform_opts(args: &Args) -> Result<TransformOptions> {
    let mut o = TransformOptions::default();
    if let Some(p) = args.flag("period") {
        o.poll_period = p.parse().context("invalid --period")?;
    }
    if let Some(p) = args.flag("stack-pages") {
        o.stack_pages = p.parse().context("invalid --stack-pages")?;
    }
    Ok(o)
}

fn load_module(path: &str, args: &Args) -> Result<WeaveModule> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {path}"))?;
    let bytes = if path.ends_with(".wat") {
        wat::parse_bytes(&bytes)?.into_owned()
    } else {
        bytes
    };
    if args.has("pre-woven") {
        let meta = extract_meta(&bytes)?;
        Ok(WeaveModule::from_transformed(bytes, meta))
    } else {
        WeaveModule::from_raw(&bytes, &transform_opts(args)?)
    }
}

fn extract_meta(wasm: &[u8]) -> Result<Meta> {
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        if let wasmparser::Payload::CustomSection(c) = payload? {
            if c.name() == weave_core::names::META_SECTION {
                return Meta::decode(c.data());
            }
        }
    }
    bail!("module has no weave.meta section (transform it first, or drop --pre-woven)")
}

fn cmd_transform(args: &Args) -> Result<()> {
    let input = args.positional.first().ok_or_else(|| anyhow!(USAGE))?;
    let out = args
        .flag("o")
        .or(args.flag("out"))
        .ok_or_else(|| anyhow!("missing -o"))?;
    let bytes = std::fs::read(input).with_context(|| format!("reading {input}"))?;
    let bytes = if input.ends_with(".wat") {
        wat::parse_bytes(&bytes)?.into_owned()
    } else {
        bytes
    };
    let res = weave_transform::transform(&bytes, &transform_opts(args)?)?;
    std::fs::write(out, &res.wasm).with_context(|| format!("writing {out}"))?;
    eprintln!(
        "woven {} -> {} ({} bytes, {} entries, poll period {})",
        input,
        out,
        res.wasm.len(),
        res.meta.entries.len(),
        res.meta.poll_period
    );
    Ok(())
}

// ---------------- built-in host services ----------------

/// Accumulator state shared by the emit services. Snapshot layout: count u64
/// LE, then sum i64 LE. The Node and Go runners implement the identical
/// byte-compatible service.
#[derive(Default, Clone)]
pub struct EmitState {
    count: u64,
    sum: i64,
}

struct EmitSvc {
    name: &'static str,
    state: Arc<Mutex<EmitState>>,
}

impl HostService for EmitSvc {
    fn name(&self) -> &str {
        self.name
    }
    fn snapshot(&self) -> Vec<u8> {
        let s = self.state.lock().unwrap();
        let mut out = Vec::with_capacity(16);
        out.extend_from_slice(&s.count.to_le_bytes());
        out.extend_from_slice(&s.sum.to_le_bytes());
        out
    }
    fn restore(&mut self, blob: &[u8]) -> Result<()> {
        if blob.len() != 16 {
            bail!("bad emit service snapshot");
        }
        let mut s = self.state.lock().unwrap();
        s.count = u64::from_le_bytes(blob[..8].try_into().unwrap());
        s.sum = i64::from_le_bytes(blob[8..16].try_into().unwrap());
        Ok(())
    }
}

#[derive(Clone)]
struct ServiceSet {
    emit: Arc<Mutex<EmitState>>,
    emit32: Arc<Mutex<EmitState>>,
    emit64: Arc<Mutex<EmitState>>,
}

impl ServiceSet {
    fn new() -> ServiceSet {
        ServiceSet {
            emit: Default::default(),
            emit32: Default::default(),
            emit64: Default::default(),
        }
    }

    fn services(&self) -> Vec<Box<dyn HostService>> {
        vec![
            Box::new(EmitSvc {
                name: "env.emit",
                state: self.emit.clone(),
            }),
            Box::new(EmitSvc {
                name: "env.emit32",
                state: self.emit32.clone(),
            }),
            Box::new(EmitSvc {
                name: "env.emit64",
                state: self.emit64.clone(),
            }),
        ]
    }

    fn link(&self) -> LinkFn {
        let (emit, emit32, emit64) = (self.emit.clone(), self.emit32.clone(), self.emit64.clone());
        Box::new(move |linker| {
            let st = emit.clone();
            linker.func_wrap(
                "env",
                "emit",
                move |_: wasmtime::Caller<'_, weave_wasmtime::Ctx>, i: i32, h: i64| {
                    let mut s = st.lock().unwrap();
                    s.count += 1;
                    s.sum = s.sum.wrapping_add(h).wrapping_add(i as i64);
                    println!("EMIT {i} {h}");
                },
            )?;
            let st = emit32.clone();
            linker.func_wrap(
                "env",
                "emit32",
                move |_: wasmtime::Caller<'_, weave_wasmtime::Ctx>, v: i32| {
                    let mut s = st.lock().unwrap();
                    s.count += 1;
                    s.sum = s.sum.wrapping_add(v as i64);
                    println!("EMIT32 {v}");
                },
            )?;
            let st = emit64.clone();
            linker.func_wrap(
                "env",
                "emit64",
                move |_: wasmtime::Caller<'_, weave_wasmtime::Ctx>, v: i64| {
                    let mut s = st.lock().unwrap();
                    s.count += 1;
                    s.sum = s.sum.wrapping_add(v);
                    println!("EMIT64 {v}");
                },
            )?;
            Ok(())
        })
    }
}

fn check_imports(meta: &Meta) -> Result<()> {
    for imp in &meta.imports {
        let known = inspect::builtin_imports().iter().any(|provided| {
            provided.module == imp.module
                && provided.name == imp.name
                && provided.params == inspect::types(&imp.params)
                && provided.results == inspect::types(&imp.results)
        });
        if !known {
            bail!(
                "module imports {}.{} with a signature this runner does not provide \
                 (built-ins: env.emit(i32,i64), env.emit32(i32), env.emit64(i64))",
                imp.module,
                imp.name
            );
        }
    }
    Ok(())
}

fn parse_entry_args(meta: &Meta, entry: &str, raw: &[String]) -> Result<Vec<Val>> {
    let e = meta
        .entry_index(entry)
        .map(|i| &meta.entries[i])
        .ok_or_else(|| anyhow!("module has no entry {entry}"))?;
    if e.params.len() != raw.len() {
        bail!(
            "entry {entry} takes {} args, got {}",
            e.params.len(),
            raw.len()
        );
    }
    e.params
        .iter()
        .zip(raw)
        .map(|(ty, s)| {
            Ok(match ty {
                ValType::I32 => Val::I32(s.parse()?),
                ValType::I64 => Val::I64(s.parse()?),
                ValType::F32 => Val::F32(s.parse::<f32>()?.to_bits()),
                ValType::F64 => Val::F64(s.parse::<f64>()?.to_bits()),
                other => bail!("cannot pass {other:?} on the command line"),
            })
        })
        .collect()
}

fn print_done(vals: &[Val]) {
    let rendered: Vec<String> = vals
        .iter()
        .map(|v| match v {
            Val::I32(x) => x.to_string(),
            Val::I64(x) => x.to_string(),
            Val::F32(b) => f32::from_bits(*b).to_string(),
            Val::F64(b) => f64::from_bits(*b).to_string(),
            other => format!("{other:?}"),
        })
        .collect();
    println!("WEAVE_DONE [{}]", rendered.join(", "));
}

fn cmd_run(args: &Args) -> Result<()> {
    let path = args.positional.first().ok_or_else(|| anyhow!(USAGE))?;
    let entry = args
        .flag("invoke")
        .ok_or_else(|| anyhow!("missing --invoke"))?;
    let module = load_module(path, args)?;
    check_imports(&module.meta)?;
    let call_args = parse_entry_args(&module.meta, entry, &args.multi("arg"))?;
    let engine = default_engine()?;
    let set = ServiceSet::new();
    let mut inst = WeaveInstance::new_fresh(&engine, &module, set.services(), vec![], set.link())?;
    match inst.call_entry(entry, &call_args)? {
        WorkResult::Done(vals) => {
            print_done(&vals);
            Ok(())
        }
        WorkResult::Unwound => bail!("workload unwound without a migration in flight"),
    }
}

fn cmd_checkpoint(args: &Args) -> Result<()> {
    let path = args.positional.first().ok_or_else(|| anyhow!(USAGE))?;
    let entry = args
        .flag("invoke")
        .ok_or_else(|| anyhow!("missing --invoke"))?;
    let after: u64 = args
        .flag("after-polls")
        .ok_or_else(|| anyhow!("missing --after-polls"))?
        .parse()?;
    let out = args.flag("o").ok_or_else(|| anyhow!("missing -o"))?;
    let module = load_module(path, args)?;
    check_imports(&module.meta)?;
    let call_args = parse_entry_args(&module.meta, entry, &args.multi("arg"))?;
    let engine = default_engine()?;
    let set = ServiceSet::new();
    let mut inst = WeaveInstance::new_fresh(&engine, &module, set.services(), vec![], set.link())?;
    inst.set_poller(weave_wasmtime::Poller::UnwindAfter(after));
    match inst.call_entry(entry, &call_args)? {
        WorkResult::Done(vals) => {
            eprintln!("workload completed before checkpoint");
            print_done(&vals);
            Ok(())
        }
        WorkResult::Unwound => {
            let snap = inst.checkpoint()?;
            std::fs::write(out, snap.encode())?;
            eprintln!(
                "checkpoint written to {out} ({} memories, {} globals, {} services)",
                snap.memories.len(),
                snap.globals.len(),
                snap.services.len()
            );
            println!("WEAVE_CHECKPOINTED");
            Ok(())
        }
    }
}

fn cmd_restore(args: &Args) -> Result<()> {
    let path = args.positional.first().ok_or_else(|| anyhow!(USAGE))?;
    let snap_path = args.positional.get(1).ok_or_else(|| anyhow!(USAGE))?;
    let module = load_module(path, args)?;
    check_imports(&module.meta)?;
    let snap_bytes = std::fs::read(snap_path)?;
    let snap = weave_core::Snapshot::decode(&snap_bytes)?;
    let engine = default_engine()?;
    let set = ServiceSet::new();
    let mut inst = weave_wasmtime::migrate::restore_from_snapshot(
        &engine,
        &module,
        &snap,
        set.services(),
        vec![],
        set.link(),
    )?;
    match inst.resume()? {
        WorkResult::Done(vals) => {
            print_done(&vals);
            Ok(())
        }
        WorkResult::Unwound => bail!("restored workload unwound unexpectedly"),
    }
}

fn cmd_serve(args: &Args) -> Result<()> {
    let listen = args
        .flag("listen")
        .ok_or_else(|| anyhow!("missing --listen"))?;
    let engine = default_engine()?;
    let set = ServiceSet::new();
    let initial = match args.flag("module") {
        Some(path) => {
            let entry = args
                .flag("invoke")
                .ok_or_else(|| anyhow!("missing --invoke"))?;
            let module = load_module(path, args)?;
            check_imports(&module.meta)?;
            let call_args = parse_entry_args(&module.meta, entry, &args.multi("arg"))?;
            Some(InitialWork {
                module,
                entry: entry.to_string(),
                args: call_args,
            })
        }
        None => None,
    };
    let mut source_opts = weave_host::source::SourceOptions::default();
    if let Some(b) = args.flag("budget") {
        source_opts.budget_bytes = b.parse()?;
    }
    if let Some(m) = args.flag("max-rounds") {
        source_opts.max_rounds = m.parse()?;
    }
    if let Some(d) = args.flag("dirty-threshold") {
        source_opts.dirty_page_threshold = d.parse()?;
    }
    let config = NodeConfig {
        listen: listen.to_string(),
        runtime_name: "wasmtime".into(),
        source_opts,
        exit_on_done: args.has("exit-on-done"),
    };
    let set_services = set.clone();
    let set_link = set.clone();
    let factories = NodeFactories {
        make_services: Box::new(move || (set_services.services(), vec![])),
        make_link: Box::new(move || set_link.link()),
    };
    serve_with_capabilities(
        &engine,
        config,
        factories,
        initial,
        inspect::builtin_capabilities(),
    )
}
