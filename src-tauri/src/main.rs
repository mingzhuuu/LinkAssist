// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "snapshot") {
        if args.len() != 3 {
            eprintln!("Usage: linkassist.exe snapshot <output.exe>");
            std::process::exit(2);
        }
        match linkassist_lib::create_snapshot(&args[2]) {
            Ok(report) => {
                println!("Snapshot created: {}", report.output.display());
                println!(
                    "Resources: {} files, {} bytes",
                    report.resource_files, report.resource_bytes
                );
                println!("Snapshot ID: {}", report.snapshot_id);
                for warning in report.warnings {
                    println!("Snapshot warning: {warning}");
                }
            }
            Err(error) => {
                eprintln!("Snapshot failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Err(error) = linkassist_lib::prepare_snapshot_runtime() {
        eprintln!("Cannot start LinkAssist snapshot: {error}");
        std::process::exit(1);
    }
    if args.iter().any(|arg| arg == "--mcp-bridge") {
        if let Err(error) = linkassist_lib::run_mcp_bridge() {
            eprintln!("MCP bridge error: {}", error);
            std::process::exit(1);
        }
        return;
    }

    if args.iter().any(|arg| arg == "--core-headless") {
        linkassist_lib::run_core_headless();
        return;
    }

    linkassist_lib::run()
}
