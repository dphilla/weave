mod control;
mod ffi;
mod node;
mod runtime;
mod services;

use anyhow::{anyhow, bail, Context, Result};
use node::{InitialWork, NodeConfig};
use runtime::{ModuleImage, RuntimeGuard, WamrInstance, WorkResult, DEFAULT_STACK_SIZE};
use std::collections::VecDeque;
use std::io::{BufReader, BufWriter, Write};
use std::net::TcpStream;
use weave_core::wire::Frame;
use weave_core::{Meta, Val, ValType};
use weave_host::source::SourceOptions;
use weave_host::target::DEFAULT_MAX_MEMORY_BYTES;

const USAGE: &str = "usage:
  weave-wamr run MODULE --invoke NAME [--arg VALUE]... [--stack-size BYTES]
  weave-wamr serve --listen ADDR [--module MODULE --invoke NAME [--arg VALUE]...]
                   [--budget BYTES] [--max-rounds N] [--dirty-threshold N]
                   [--stack-size BYTES] [--max-memory-bytes BYTES] [--exit-on-done]
  weave-wamr migrate --node ADDR --to ADDR
  weave-wamr status --node ADDR

MODULE must already contain weave.meta (produce it with `weave transform`).";

// WAMR 2.4.4's classic interpreter consumes slightly more than macOS's
// default 8 MiB native main-thread stack for transformed modules. Keep all
// WAMR work on one generously-sized worker; the Weave guest contract is
// single-threaded regardless.
const WAMR_WORKER_STACK: usize = 32 * 1024 * 1024;

fn main() {
    if let Err(error) = run() {
        eprintln!("weave-wamr: error: {error:#}");
        std::process::exit(1);
    }
}

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(mut input: VecDeque<String>) -> Self {
        let mut args = Self::default();
        while let Some(argument) = input.pop_front() {
            if let Some(flag) = argument.strip_prefix("--") {
                let takes_value = matches!(
                    flag,
                    "invoke"
                        | "arg"
                        | "listen"
                        | "module"
                        | "node"
                        | "to"
                        | "budget"
                        | "max-rounds"
                        | "dirty-threshold"
                        | "stack-size"
                        | "max-memory-bytes"
                );
                args.flags.push((
                    flag.to_owned(),
                    if takes_value { input.pop_front() } else { None },
                ));
            } else {
                args.positional.push(argument);
            }
        }
        args
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(candidate, _)| candidate == name)
            .and_then(|(_, value)| value.as_deref())
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(candidate, _)| candidate == name)
    }

    fn multi(&self, name: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(candidate, _)| candidate == name)
            .filter_map(|(_, value)| value.clone())
            .collect()
    }
}

fn run() -> Result<()> {
    let mut argv: VecDeque<String> = std::env::args().skip(1).collect();
    let command = argv.pop_front().ok_or_else(|| anyhow!(USAGE))?;
    let args = Args::parse(argv);
    match command.as_str() {
        "run" => command_run(&args),
        "serve" => command_serve(&args),
        "migrate" => command_control(&args, true),
        "status" => command_control(&args, false),
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        other => bail!("unknown command {other}\n{USAGE}"),
    }
}

fn command_run(args: &Args) -> Result<()> {
    let path = args
        .positional
        .first()
        .map(String::as_str)
        .or_else(|| args.flag("module"))
        .ok_or_else(|| anyhow!("missing MODULE\n{USAGE}"))?;
    let entry = args
        .flag("invoke")
        .ok_or_else(|| anyhow!("missing --invoke"))?;
    let image = load_image(path)?;
    let values = parse_entry_args(&image.meta, entry, &args.multi("arg"))?;
    let stack_size = stack_size(args)?;

    let entry = entry.to_owned();
    with_wamr(move || {
        let mut instance =
            WamrInstance::instantiate(image, stack_size, None, SourceOptions::default())?;
        instance.initialize_fresh()?;
        match instance.call_entry(&entry, &values)? {
            WorkResult::Done(results) => {
                println!("WEAVE_DONE [{}]", node::render_values(&results).join(", "));
                Ok(())
            }
            WorkResult::Unwound => bail!("workload unwound without a migration in flight"),
        }
    })
}

fn command_serve(args: &Args) -> Result<()> {
    let listen = args
        .flag("listen")
        .ok_or_else(|| anyhow!("missing --listen"))?;
    let stack_size = stack_size(args)?;
    let max_memory_bytes = match args.flag("max-memory-bytes") {
        Some(value) => value.parse().context("invalid --max-memory-bytes")?,
        None => DEFAULT_MAX_MEMORY_BYTES,
    };
    if max_memory_bytes == 0 {
        bail!("--max-memory-bytes must be greater than zero");
    }
    let mut source_options = SourceOptions::default();
    if let Some(value) = args.flag("budget") {
        source_options.budget_bytes = value.parse().context("invalid --budget")?;
    }
    if let Some(value) = args.flag("max-rounds") {
        source_options.max_rounds = value.parse().context("invalid --max-rounds")?;
    }
    if let Some(value) = args.flag("dirty-threshold") {
        source_options.dirty_page_threshold = value.parse().context("invalid --dirty-threshold")?;
    }
    if source_options.budget_bytes == 0 {
        bail!("--budget must be greater than zero");
    }
    if source_options.max_rounds == 0 {
        bail!("--max-rounds must be greater than zero");
    }

    let initial = match args.flag("module") {
        Some(path) => {
            let entry = args
                .flag("invoke")
                .ok_or_else(|| anyhow!("--module requires --invoke"))?;
            let image = load_image(path)?;
            let values = parse_entry_args(&image.meta, entry, &args.multi("arg"))?;
            Some(InitialWork {
                image,
                entry: entry.to_owned(),
                args: values,
            })
        }
        None => {
            if args.flag("invoke").is_some() || !args.multi("arg").is_empty() {
                bail!("--invoke/--arg require --module");
            }
            None
        }
    };

    let config = NodeConfig {
        listen: listen.to_owned(),
        source_options,
        stack_size,
        max_memory_bytes,
        exit_on_done: args.has("exit-on-done"),
    };
    with_wamr(move || node::serve(config, initial))
}

fn command_control(args: &Args, migrate: bool) -> Result<()> {
    let node = args.flag("node").ok_or_else(|| anyhow!("missing --node"))?;
    let connection =
        TcpStream::connect(node).with_context(|| format!("connecting to node {node}"))?;
    connection.set_nodelay(true).ok();
    let mut writer = BufWriter::new(connection.try_clone()?);
    let mut reader = BufReader::new(connection);
    if migrate {
        let target = args.flag("to").ok_or_else(|| anyhow!("missing --to"))?;
        Frame::CtlMigrate {
            target: target.to_owned(),
        }
        .write_to(&mut writer)?;
    } else {
        Frame::CtlStatus.write_to(&mut writer)?;
    }
    writer.flush()?;
    match Frame::read_from(&mut reader)? {
        Frame::CtlOk { msg } => {
            println!("ok: {msg}");
            Ok(())
        }
        Frame::CtlErr { msg } => bail!("node error: {msg}"),
        other => bail!("unexpected control reply {other:?}"),
    }
}

fn load_image(path: &str) -> Result<ModuleImage> {
    let bytes = std::fs::read(path).with_context(|| format!("reading module {path}"))?;
    ModuleImage::parse(bytes).with_context(|| format!("loading module {path}"))
}

fn stack_size(args: &Args) -> Result<u32> {
    let value = match args.flag("stack-size") {
        Some(value) => value.parse().context("invalid --stack-size")?,
        None => DEFAULT_STACK_SIZE,
    };
    if value == 0 {
        bail!("--stack-size must be greater than zero");
    }
    Ok(value)
}

fn parse_entry_args(meta: &Meta, entry: &str, raw: &[String]) -> Result<Vec<Val>> {
    let entry = meta
        .entry_index(entry)
        .and_then(|index| meta.entries.get(index))
        .ok_or_else(|| anyhow!("module has no entry {entry}"))?;
    if entry.params.len() != raw.len() {
        bail!(
            "entry {} takes {} args, got {}",
            entry.name,
            entry.params.len(),
            raw.len()
        );
    }
    entry
        .params
        .iter()
        .zip(raw)
        .map(|(ty, value)| {
            Ok(match ty {
                ValType::I32 => Val::i32(value.parse()?),
                ValType::I64 => Val::i64(value.parse()?),
                ValType::F32 => Val::f32_bits(value.parse::<f32>()?.to_bits()),
                ValType::F64 => Val::f64_bits(value.parse::<f64>()?.to_bits()),
                ValType::V128 => bail!("v128 command-line arguments are not supported"),
                ValType::FuncRef => bail!("funcref command-line arguments are not supported"),
            })
        })
        .collect()
}

fn with_wamr(task: impl FnOnce() -> Result<()> + Send + 'static) -> Result<()> {
    let worker = std::thread::Builder::new()
        .name("weave-wamr-runtime".to_owned())
        .stack_size(WAMR_WORKER_STACK)
        .spawn(move || {
            // Initializing and destroying WAMR on its sole execution thread
            // also keeps WAMR's thread-local signal state correctly paired.
            let _runtime = RuntimeGuard::initialize()?;
            task()
        })
        .context("starting WAMR runtime worker")?;
    match worker.join() {
        Ok(result) => result,
        Err(_) => bail!("WAMR runtime worker panicked"),
    }
}
