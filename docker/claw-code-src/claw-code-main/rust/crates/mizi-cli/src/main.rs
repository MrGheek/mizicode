mod config;
mod mizi_client;
mod openai_client;

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use config::MiziConfig;
use mizi_client::MiziApiClient;
use openai_client::OpenAiRuntimeClient;
use rustyline::DefaultEditor;

use runtime::{ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, Session, TokenUsage};
use tools::{execute_tool, mvp_tool_specs, ToolSpec};

const DEFAULT_MODEL: &str = "gpt-4o";
const DEFAULT_SYSTEM_PROMPT: &str = "You are MIZI, a terminal-native AI coding assistant. You have access to tools that let you read, write, and edit files, run shell commands, search the web, and more. Use them to help the user with their tasks. Think step by step before calling tools. When you have completed the task, summarize what you did.";

// ── CLI ─────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "mizi",
    version,
    about = "MIZI CLI — terminal-native AI coding assistant"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(short = 'm', long = "model", help = "Model name")]
    model: Option<String>,

    #[arg(short = 'p', long = "prompt", help = "Single-turn prompt")]
    prompt: Option<String>,

    #[arg(long = "provider", help = "API base URL (OpenAI-compatible)")]
    provider: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start an interactive REPL session
    Repl {
        #[arg(short = 'm', long = "model")]
        model: Option<String>,
    },
    /// List, show, create, or stop MIZI API sessions
    Sessions {
        #[command(subcommand)]
        action: Option<SessionAction>,
    },
    /// Show or set local MIZI CLI configuration
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    List,
    Create {
        #[arg(short = 't', long = "title")]
        title: Option<String>,
    },
    Show {
        id: u64,
    },
    Stop {
        id: u64,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print the current local configuration
    Show,
    /// Update and persist the local configuration
    Set {
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        provider: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    let stored_config = MiziConfig::load();

    let model = cli
        .model
        .clone()
        .or_else(|| {
            if let Some(Commands::Repl { model: m }) = &cli.command {
                m.clone()
            } else {
                None
            }
        })
        .or(stored_config.default_model)
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    match cli.command {
        Some(Commands::Repl { .. }) => {
            run_repl(&model, cli.provider.as_deref());
        }
        Some(Commands::Sessions { action }) => {
            run_session_action(action.as_ref(), cli.provider);
        }
        Some(Commands::Config { action }) => {
            run_config_action(action);
        }
        None if cli.prompt.is_none() => {
            run_repl(&model, cli.provider.as_deref());
        }
        _ => {
            let prompt = cli.prompt.clone().unwrap_or_default();
            if prompt.is_empty() {
                eprintln!("error: --prompt is required for single-shot mode");
                std::process::exit(1);
            }
            run_single_turn(&prompt, &model, cli.provider.as_deref());
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn get_provider() -> String {
    let config = MiziConfig::load();
    config.default_provider.unwrap_or(config.api_base_url)
}

fn get_api_key() -> String {
    std::env::var("MIZI_LLM_API_KEY")
        .or_else(|_| std::env::var("OPENAI_API_KEY"))
        .unwrap_or_else(|_| {
            eprintln!("error: MIZI_LLM_API_KEY or OPENAI_API_KEY must be set");
            std::process::exit(1);
        })
}

fn build_client(model: &str, provider: Option<&str>) -> OpenAiRuntimeClient {
    let default = get_provider();
    let base = provider.unwrap_or(&default);
    let key = get_api_key();
    OpenAiRuntimeClient::new(base.to_string(), key, model.to_string())
}

fn history_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("mizi").join("history.txt")
}

fn session_id() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

// ── Session persistence ─────────────────────────────────────────────────

fn save_session(messages: &[ConversationMessage]) -> Result<String, String> {
    let dir = MiziConfig::sessions_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("session-{}.json", session_id()));
    let session = Session {
        version: 1,
        messages: messages.to_vec(),
    };
    session.save_to_path(&path).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn load_session(path: &str) -> Result<Vec<ConversationMessage>, String> {
    Session::load_from_path(path)
        .map(|session| session.messages)
        .map_err(|e| e.to_string())
}

// ── Single turn ──────────────────────────────────────────────────────────

fn run_single_turn(prompt: &str, model: &str, provider: Option<&str>) {
    let mut client = build_client(model, provider);
    let tools = mvp_tool_specs();
    let request = ApiRequest {
        system_prompt: vec![DEFAULT_SYSTEM_PROMPT.to_string()],
        messages: vec![ConversationMessage::user_text(prompt)],
    };

    match client.stream_with_tools(&request, &tools) {
        Ok(events) => {
            for event in events {
                match event {
                    AssistantEvent::TextDelta(text) => {
                        print!("{text}");
                        io::stdout().flush().ok();
                    }
                    AssistantEvent::ToolUse { id, name, input } => {
                        eprintln!("\n[Tool: {name} ({id})]\n{input}");
                    }
                    AssistantEvent::Usage(u) => {
                        eprintln!(
                            "\n[Tokens: {} in / {} out]",
                            u.input_tokens, u.output_tokens
                        );
                    }
                    AssistantEvent::MessageStop => {}
                }
            }
            println!();
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

// ── Tool execution loop ──────────────────────────────────────────────────

#[allow(clippy::too_many_lines)]
fn run_tool_loop(
    client: &mut OpenAiRuntimeClient,
    tools: &[ToolSpec],
    messages: &mut Vec<ConversationMessage>,
    system_prompt: &str,
) {
    const MAX_LOOPS: usize = 25;
    for _iteration in 0..MAX_LOOPS {
        let request = ApiRequest {
            system_prompt: vec![system_prompt.to_string()],
            messages: messages.clone(),
        };

        let events = match client.stream_with_tools(&request, tools) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("error: {e}");
                return;
            }
        };

        let mut text = String::new();
        let mut tool_calls: Vec<ContentBlock> = Vec::new();
        let mut tool_results: Vec<ConversationMessage> = Vec::new();
        let mut usage: Option<TokenUsage> = None;

        for event in &events {
            match event {
                AssistantEvent::TextDelta(t) => {
                    print!("{t}");
                    io::stdout().flush().ok();
                    text.push_str(t);
                }
                AssistantEvent::ToolUse { id, name, input } => {
                    tool_calls.push(ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });

                    let parsed = match serde_json::from_str::<serde_json::Value>(input) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("\n  ✗ {name} parse error: {e}");
                            tool_results.push(ConversationMessage::tool_result(
                                id.clone(),
                                name.clone(),
                                format!("Failed to parse input: {e}"),
                                true,
                            ));
                            continue;
                        }
                    };

                    eprintln!("\n  → running {name}…");
                    match execute_tool(name, &parsed) {
                        Ok(output) => {
                            eprintln!("  ✓ {name} done");
                            tool_results.push(ConversationMessage::tool_result(
                                id.clone(),
                                name.clone(),
                                output,
                                false,
                            ));
                        }
                        Err(e) => {
                            eprintln!("  ✗ {name} error: {e}");
                            tool_results.push(ConversationMessage::tool_result(
                                id.clone(),
                                name.clone(),
                                format!("Error: {e}"),
                                true,
                            ));
                        }
                    }
                }
                AssistantEvent::Usage(u) => {
                    usage = Some(*u);
                }
                AssistantEvent::MessageStop => {}
            }
        }

        // Push assistant message with text + tool_calls
        let mut blocks: Vec<ContentBlock> = Vec::new();
        if !text.is_empty() {
            blocks.push(ContentBlock::Text { text });
        }
        blocks.extend(tool_calls);
        if !blocks.is_empty() {
            messages.push(ConversationMessage::assistant(blocks));
        }

        // Push tool results
        let num_tool_calls = tool_results.len();
        for tr in tool_results {
            messages.push(tr);
        }

        if let Some(u) = usage {
            eprintln!(
                "\n[Tokens: {} in / {} out]",
                u.input_tokens, u.output_tokens
            );
        }

        // If no tool calls, we're done
        if num_tool_calls == 0 {
            break;
        }

        eprintln!();
    }
}

// ── REPL ─────────────────────────────────────────────────────────────────

fn run_repl(model: &str, provider: Option<&str>) {
    let mut client = build_client(model, provider);
    let tools = mvp_tool_specs();
    let mut history: Vec<ConversationMessage> = Vec::new();

    // Load previous history if available
    let hist_path = history_path();
    let _ = std::fs::create_dir_all(hist_path.parent().unwrap());

    let mut rl = DefaultEditor::new().expect("rustyline editor");
    if hist_path.exists() {
        let _ = rl.load_history(&hist_path);
    }

    eprintln!("MIZI REPL — model: {model}");
    eprintln!("  /help  /memory  /skills  /plan  /ambient  /exit");
    eprintln!("  Ctrl+C to quit, ↑↓ for history");

    loop {
        let readline = rl.readline("> ");
        match readline {
            Ok(line) => {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }

                rl.add_history_entry(&trimmed).ok();
                let _ = rl.save_history(&hist_path);

                if trimmed.starts_with("/exit") || trimmed.starts_with("/quit") {
                    // Save on exit
                    if !history.is_empty() {
                        match save_session(&history) {
                            Ok(p) => eprintln!("[Session saved to {p}]"),
                            Err(e) => eprintln!("[Save error: {e}]"),
                        }
                    }
                    break;
                }

                if trimmed.starts_with('/') {
                    if trimmed == "/save" || trimmed.starts_with("/save ") {
                        match save_session(&history) {
                            Ok(p) => eprintln!("[Session saved to {p}]"),
                            Err(e) => eprintln!("[Save error: {e}]"),
                        }
                    } else if let Some(path) = trimmed.strip_prefix("/load ") {
                        match load_session(path.trim()) {
                            Ok(msgs) => {
                                history = msgs;
                                eprintln!("[Loaded {} messages]", history.len());
                            }
                            Err(e) => eprintln!("[Load error: {e}]"),
                        }
                    } else {
                        handle_slash_command(&trimmed);
                    }
                    continue;
                }

                // Push user message and run the tool loop
                history.push(ConversationMessage::user_text(trimmed));

                run_tool_loop(&mut client, &tools, &mut history, DEFAULT_SYSTEM_PROMPT);
            }
            Err(rustyline::error::ReadlineError::Interrupted) => {
                eprintln!("\n(interrupted)");
            }
            Err(rustyline::error::ReadlineError::Eof) => {
                break;
            }
            Err(e) => {
                eprintln!("error: {e}");
                break;
            }
        }
    }

    let _ = rl.save_history(&hist_path);
}

// ── Slash commands ───────────────────────────────────────────────────────

fn handle_slash_command(cmd: &str) {
    let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
    let command = parts[0];
    let args = parts.get(1).copied().unwrap_or("");

    match command {
        "/help" => {
            eprintln!("Commands:");
            eprintln!("  /help              Show this help");
            eprintln!("  /clear             Clear conversation history");
            eprintln!("  /save              Save session to disk");
            eprintln!("  /load <file>       Load session from disk");
            eprintln!("  /memory <query>    Recall memories from MIZI API");
            eprintln!("  /observe <text>    Store an observation");
            eprintln!("  /skills            List available skills");
            eprintln!("  /skill <id>        Show a single skill");
            eprintln!("  /bundle            Show the active skill bundle");
            eprintln!("  /plan [id]         List plans, or show a single plan");
            eprintln!("  /ambient           List ambient cycles");
            eprintln!("  /repo              Show repo context");
            eprintln!("  /phase             Show current MIZI phase");
            eprintln!("  /server-config     Show remote MIZI server config");
            eprintln!("  /exit              Exit REPL");
        }
        "/clear" => {
            eprintln!("[History cleared]");
        }
        "/memory" | "/recall" => {
            if args.is_empty() {
                eprintln!("usage: /memory <query>");
                return;
            }
            call_mizi_api(|client| client.recall_memories(args));
        }
        "/observe" => {
            if args.is_empty() {
                eprintln!("usage: /observe <text>");
                return;
            }
            call_mizi_api(|client| client.observe_memory(args));
        }
        "/skills" => {
            call_mizi_api(MiziApiClient::list_skills);
        }
        "/skill" => {
            if args.is_empty() {
                eprintln!("usage: /skill <id>");
                return;
            }
            call_mizi_api(|client| client.get_skill(args));
        }
        "/bundle" => {
            call_mizi_api(MiziApiClient::get_active_bundle);
        }
        "/plan" => {
            if args.is_empty() {
                call_mizi_api(MiziApiClient::list_plans);
            } else {
                match args.parse::<u64>() {
                    Ok(id) => call_mizi_api(|client| client.get_plan(id)),
                    Err(_) => eprintln!("usage: /plan [id]"),
                }
            }
        }
        "/ambient" => {
            call_mizi_api(MiziApiClient::list_ambient_cycles);
        }
        "/repo" => {
            call_mizi_api(MiziApiClient::get_repo_context);
        }
        "/phase" => {
            call_mizi_api(MiziApiClient::get_phase);
        }
        "/server-config" => {
            call_mizi_api(MiziApiClient::get_config);
        }
        _ => {
            eprintln!("unknown command: {command}. Type /help");
        }
    }
}

fn call_mizi_api<F>(f: F)
where
    F: FnOnce(&MiziApiClient) -> Result<serde_json::Value, String>,
{
    let config = MiziConfig::load();
    let auth = std::env::var("MIZI_MEM_AUTH_TOKEN").unwrap_or_default();
    if auth.is_empty() {
        eprintln!("  (set MIZI_MEM_AUTH_TOKEN to enable MIZI API access)");
        return;
    }
    let client = MiziApiClient::new(&config.api_base_url, auth);
    match f(&client) {
        Ok(result) => {
            let pretty = serde_json::to_string_pretty(&result).unwrap_or_default();
            println!("{pretty}");
        }
        Err(e) => eprintln!("  error: {e}"),
    }
}

// ── Session commands ─────────────────────────────────────────────────────

fn run_session_action(action: Option<&SessionAction>, provider: Option<String>) {
    let config = MiziConfig::load();
    let auth = std::env::var("MIZI_MEM_AUTH_TOKEN").unwrap_or_else(|_| {
        eprintln!("error: MIZI_MEM_AUTH_TOKEN must be set");
        std::process::exit(1);
    });

    let client = MiziApiClient::new(&provider.unwrap_or(config.api_base_url), auth);

    match action {
        None | Some(SessionAction::List) => match client.list_sessions() {
            Ok(sessions) => {
                let pretty = serde_json::to_string_pretty(&sessions).unwrap_or_default();
                println!("{pretty}");
            }
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Some(SessionAction::Create { title }) => match client.create_session(title.as_deref()) {
            Ok(session) => {
                let pretty = serde_json::to_string_pretty(&session).unwrap_or_default();
                println!("{pretty}");
            }
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Some(SessionAction::Show { id }) => match client.get_session(*id) {
            Ok(session) => {
                let pretty = serde_json::to_string_pretty(&session).unwrap_or_default();
                println!("{pretty}");
            }
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Some(SessionAction::Stop { id }) => match client.stop_session(*id) {
            Ok(result) => println!("{result}"),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
    }
}

// ── Config commands ──────────────────────────────────────────────────────

fn run_config_action(action: Option<ConfigAction>) {
    match action.unwrap_or(ConfigAction::Show) {
        ConfigAction::Show => {
            let config = MiziConfig::load();
            match toml::to_string_pretty(&config) {
                Ok(s) => println!("{s}"),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ConfigAction::Set { model, provider } => {
            let mut config = MiziConfig::load();
            if model.is_some() {
                config.default_model = model;
            }
            if provider.is_some() {
                config.default_provider = provider;
            }
            config.save();
            println!("[Config saved to {}]", MiziConfig::path().display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(args)
    }

    #[test]
    fn defaults_to_no_subcommand() {
        let cli = parse(&["mizi"]);
        assert!(cli.command.is_none());
        assert!(cli.model.is_none());
        assert!(cli.prompt.is_none());
    }

    #[test]
    fn parses_single_shot_prompt_and_model() {
        let cli = parse(&["mizi", "-p", "hello", "-m", "gpt-4o-mini"]);
        assert_eq!(cli.prompt.as_deref(), Some("hello"));
        assert_eq!(cli.model.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn parses_provider_flag() {
        let cli = parse(&["mizi", "--provider", "https://example.com"]);
        assert_eq!(cli.provider.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn parses_repl_subcommand_with_model() {
        let cli = parse(&["mizi", "repl", "-m", "gpt-4o-mini"]);
        match cli.command {
            Some(Commands::Repl { model }) => assert_eq!(model.as_deref(), Some("gpt-4o-mini")),
            _ => panic!("expected Repl command"),
        }
    }

    #[test]
    fn parses_sessions_subcommands() {
        match parse(&["mizi", "sessions", "list"]).command {
            Some(Commands::Sessions {
                action: Some(SessionAction::List),
            }) => {}
            _ => panic!("expected sessions list"),
        }

        match parse(&["mizi", "sessions", "create", "--title", "demo"]).command {
            Some(Commands::Sessions {
                action: Some(SessionAction::Create { title }),
            }) => assert_eq!(title.as_deref(), Some("demo")),
            _ => panic!("expected sessions create"),
        }

        match parse(&["mizi", "sessions", "show", "42"]).command {
            Some(Commands::Sessions {
                action: Some(SessionAction::Show { id }),
            }) => assert_eq!(id, 42),
            _ => panic!("expected sessions show"),
        }

        match parse(&["mizi", "sessions", "stop", "7"]).command {
            Some(Commands::Sessions {
                action: Some(SessionAction::Stop { id }),
            }) => assert_eq!(id, 7),
            _ => panic!("expected sessions stop"),
        }
    }

    #[test]
    fn parses_config_subcommands() {
        match parse(&["mizi", "config"]).command {
            Some(Commands::Config { action: None }) => {}
            _ => panic!("expected bare config command"),
        }

        match parse(&["mizi", "config", "show"]).command {
            Some(Commands::Config {
                action: Some(ConfigAction::Show),
            }) => {}
            _ => panic!("expected config show"),
        }

        match parse(&[
            "mizi",
            "config",
            "set",
            "--model",
            "gpt-4o-mini",
            "--provider",
            "https://example.com",
        ])
        .command
        {
            Some(Commands::Config {
                action: Some(ConfigAction::Set { model, provider }),
            }) => {
                assert_eq!(model.as_deref(), Some("gpt-4o-mini"));
                assert_eq!(provider.as_deref(), Some("https://example.com"));
            }
            _ => panic!("expected config set"),
        }
    }
}
