use anyhow::{bail, Result};
use std::collections::VecDeque;

pub(crate) struct Args {
    pub positional: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

impl Args {
    pub fn parse(cmd: &str, mut argv: VecDeque<String>) -> Result<Self> {
        let values: &[&str] = match cmd {
            "transform" => &["o", "period", "stack-pages"],
            "run" => &["invoke", "arg", "period", "stack-pages"],
            "checkpoint" => &["invoke", "arg", "after-polls", "o", "period", "stack-pages"],
            "restore" => &["period", "stack-pages"],
            "serve" => &[
                "listen",
                "module",
                "invoke",
                "arg",
                "period",
                "stack-pages",
                "budget",
                "max-rounds",
                "dirty-threshold",
            ],
            "inspect" => &[
                "invoke",
                "arg",
                "period",
                "stack-pages",
                "node",
                "timeout-ms",
            ],
            "status" => &["node", "timeout-ms"],
            "migrate" => &["node", "to", "operation-id", "node-epoch", "timeout-ms"],
            "operation" => &["node", "operation-id", "node-epoch", "timeout-ms"],
            _ => bail!("unknown command {cmd}"),
        };
        let switches: &[&str] = match cmd {
            "run" | "checkpoint" | "restore" => &["pre-woven"],
            "serve" => &["pre-woven", "exit-on-done"],
            "inspect" => &["pre-woven", "json"],
            "status" => &["json", "legacy"],
            "migrate" => &["json", "no-wait", "legacy"],
            "operation" => &["json", "wait"],
            _ => &[],
        };
        let mut args = Self {
            positional: Vec::new(),
            flags: Vec::new(),
        };
        let mut positional_only = false;
        while let Some(token) = argv.pop_front() {
            if !positional_only && token == "--" {
                positional_only = true;
                continue;
            }
            if positional_only || !token.starts_with('-') || token == "-" {
                args.positional.push(token);
                continue;
            }
            let name = match token.as_str() {
                "-h" => "help",
                "-o" | "--out" => "o",
                _ => token
                    .strip_prefix("--")
                    .ok_or_else(|| anyhow::anyhow!("unknown option {token}"))?,
            };
            if name != "arg" && args.has(name) {
                bail!("duplicate option --{name}");
            }
            let value = if values.contains(&name) {
                let value = argv
                    .pop_front()
                    .ok_or_else(|| anyhow::anyhow!("missing value for --{name}"))?;
                if value.starts_with("--") || value == "-o" || value == "-h" {
                    bail!("missing value for --{name}");
                }
                Some(value)
            } else if name == "help" || switches.contains(&name) {
                None
            } else {
                bail!("unknown option {token} for {cmd}");
            };
            args.flags.push((name.to_owned(), value));
        }
        if args.has("help") {
            return Ok(args);
        }
        let expected = match cmd {
            "transform" | "run" | "checkpoint" | "inspect" => 1,
            "restore" => 2,
            _ => 0,
        };
        if args.positional.len() != expected {
            bail!(
                "{cmd} expects {expected} positional argument(s), got {}",
                args.positional.len()
            );
        }
        let required: &[&str] = match cmd {
            "transform" => &["o"],
            "run" => &["invoke"],
            "checkpoint" => &["invoke", "after-polls", "o"],
            "serve" => &["listen"],
            "status" => &["node"],
            "migrate" => &["node", "to"],
            "operation" => &["node", "operation-id", "node-epoch"],
            _ => &[],
        };
        for name in required {
            if !args.has(name) {
                bail!("missing --{name}");
            }
        }
        if args.has("arg") && !args.has("invoke") {
            bail!("--arg requires --invoke");
        }
        if cmd == "serve" && (args.has("module") != args.has("invoke")) {
            bail!("--module and --invoke must be supplied together");
        }
        if args.has("pre-woven") && (args.has("period") || args.has("stack-pages")) {
            bail!("transform options cannot be used with --pre-woven");
        }
        if args.has("legacy")
            && ["json", "operation-id", "node-epoch", "no-wait"]
                .iter()
                .any(|name| args.has(name))
        {
            bail!("--legacy cannot provide JSON, operation identity, or asynchronous control");
        }
        if args.has("operation-id") && !args.has("node-epoch") {
            bail!("--operation-id requires --node-epoch (obtain it with status)");
        }
        for name in [
            "period",
            "stack-pages",
            "budget",
            "max-rounds",
            "timeout-ms",
        ] {
            if let Some(value) = args.flag(name) {
                let value: u64 = value
                    .parse()
                    .map_err(|_| anyhow::anyhow!("--{name} must be a positive integer"))?;
                if value == 0 {
                    bail!("--{name} must be positive");
                }
                if matches!(name, "period" | "stack-pages" | "max-rounds")
                    && value > u32::MAX as u64
                {
                    bail!("--{name} exceeds u32 range");
                }
                if name == "timeout-ms" && value > 3_600_000 {
                    bail!("--timeout-ms must be at most 3600000 (one hour)");
                }
            }
        }
        for name in ["after-polls", "dirty-threshold"] {
            if let Some(value) = args.flag(name) {
                value
                    .parse::<u64>()
                    .map_err(|_| anyhow::anyhow!("--{name} must be a nonnegative integer"))?;
            }
        }
        Ok(args)
    }
    pub fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }
    pub fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(n, _)| n == name)
    }
    pub fn multi(&self, name: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(n, _)| n == name)
            .filter_map(|(_, v)| v.clone())
            .collect()
    }
}

pub fn help(cmd: &str) -> &'static str {
    match cmd {
        "inspect" => "weave inspect MODULE [--pre-woven] [--invoke NAME --arg VALUE ...] [--node ADDR] [--timeout-ms N] [--json]\nInspect/transform/compile without instantiating or executing the guest. --node compares advertised target capabilities; it is not a reservation.",
        "status" => "weave status --node ADDR [--timeout-ms N] [--json] [--legacy]\nDiscover epoch, lifecycle, source ownership, and capabilities. Default timeout: 5000ms.",
        "migrate" => "weave migrate --node ADDR --to ADDR [--operation-id ID --node-epoch EPOCH] [--no-wait] [--timeout-ms N] [--json] [--legacy]\nDefault wait: 120000ms. Save ID + epoch before retrying; retry exactly that pair. A timeout is not proof of failure. --legacy explicitly opts out of operation safety.",
        "operation" => "weave operation --node ADDR --operation-id ID --node-epoch EPOCH [--wait] [--timeout-ms N] [--json]\nQuery an accepted operation without resubmitting it. --wait uses one total deadline (default 5000ms).",
        "transform" => "weave transform IN.wasm -o OUT.wasm [--period N] [--stack-pages N]",
        "run" => "weave run MODULE --invoke NAME [--arg VALUE]... [--pre-woven] [--period N] [--stack-pages N]",
        "checkpoint" => "weave checkpoint MODULE --invoke NAME [--arg VALUE]... --after-polls N -o SNAP [--pre-woven] [--period N] [--stack-pages N]",
        "restore" => "weave restore MODULE SNAP [--pre-woven] [--period N] [--stack-pages N]",
        "serve" => "weave serve --listen ADDR [--module MODULE --invoke NAME --arg VALUE ...] [--pre-woven] [--exit-on-done] [--period N] [--stack-pages N] [--budget N] [--max-rounds N] [--dirty-threshold N]",
        _ => super::USAGE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(cmd: &str, args: &[&str]) -> Result<Args> {
        Args::parse(cmd, args.iter().map(|s| s.to_string()).collect())
    }
    #[test]
    fn rejects_typos_duplicates_missing_values_and_extra_positionals() {
        for args in [
            vec!["a", "-o", "b", "--peroid", "2"],
            vec!["a", "-o", "b", "--out", "c"],
            vec!["a", "-o", "--help"],
            vec!["a", "b", "-o", "c"],
            vec!["a", "-o", "b", "--period", "bad"],
            vec!["a", "-o", "b", "--period", "0"],
        ] {
            assert!(parse("transform", &args).is_err(), "{args:?}");
        }
    }
    #[test]
    fn negative_repeatable_args_and_end_of_options() {
        let args = parse(
            "run",
            &[
                "--invoke", "run", "--arg", "-1", "--arg", "-2", "--", "-module",
            ],
        )
        .unwrap();
        assert_eq!(args.multi("arg"), ["-1", "-2"]);
        assert_eq!(args.positional, ["-module"]);
    }
    #[test]
    fn help_never_requires_execution_inputs() {
        for cmd in [
            "transform",
            "run",
            "checkpoint",
            "restore",
            "serve",
            "inspect",
            "status",
            "migrate",
            "operation",
        ] {
            assert!(parse(cmd, &["--help"]).unwrap().has("help"));
        }
    }
    #[test]
    fn unsafe_identity_and_legacy_combinations_rejected() {
        assert!(parse(
            "migrate",
            &["--node", "a:1", "--to", "b:2", "--operation-id", "x"]
        )
        .is_err());
        assert!(parse("status", &["--node", "a:1", "--legacy", "--json"]).is_err());
    }
}
