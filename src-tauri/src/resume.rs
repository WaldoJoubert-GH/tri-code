//! Reopening an agent's conversation in a new process, for when the terminal host couldn't keep the
//! process itself (a reboot, a power cut, a host from another version).
//!
//! Claude's session id can change within a tab (`/clear`), so a `SessionStart` hook reports it:
//! `--settings` adds the hook to this launch only, without touching the user's own settings, and
//! neither a `claude` typed in a shell nor one an agent starts inherits it. pi takes an id up front
//! and creates or reopens that session.
//!
//! Ids come back out of state.json into a command line, so they are checked here on the way out,
//! and only the token-authenticated hook can report one (agent_windows.rs). Program output can't.

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::agent_setup;

/// The conversation a tab last had, from `Tab.resume`.
#[derive(Debug, Clone, Deserialize)]
pub struct Resume {
    pub kind: String,
    pub id: String,
    /// pi only, for one launch: copy this session into the current folder as `id`. pi keeps sessions
    /// per folder, so this is how a conversation follows its tab to a Worktree (agentworktree.ts).
    #[serde(default)]
    pub fork: Option<String>,
}

/// What to run, and any environment the command refers to.
#[derive(Debug, PartialEq)]
pub struct Launch {
    pub cmd: String,
    pub env: Vec<(String, String)>,
}

/// A session id safe to put on a command line: what claude and pi use, and nothing a shell reads.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The agent a command starts, if it is one plain invocation that can take more flags: not a
/// pipeline, and not already choosing a session or running one-shot.
pub fn agent_of(cmd: &str) -> Option<&'static str> {
    let cmd = cmd.trim();
    if cmd.contains(['&', '|', ';', '<', '>', '`', '$', '%', '^', '(', ')', '\n', '"', '\'']) {
        return None;
    }
    let mut words = cmd.split_whitespace();
    let agent = match words.next()? {
        "claude" | "claude.cmd" | "claude.exe" => "claude",
        "pi" | "pi.cmd" | "pi.exe" => "pi",
        _ => return None,
    };
    const CHOOSING: [&str; 14] = ["-r", "--resume", "-c", "--continue", "--session", "--session-id", "--settings", "--fork", "--no-session", "-p", "--print", "--export", "--session-dir", "--fork-session"];
    let chooses = |w: &str| w.split('=').next().is_some_and(|f| CHOOSING.contains(&f));
    if words.any(chooses) { None } else { Some(agent) }
}

/// The command with its session flags. `settings` is the hook file, written so the platform shell
/// reads it as one word; without it (no Node) Claude runs as typed, and reports nothing.
pub fn build(cmd: &str, resume: Option<&Resume>, settings: Option<&str>) -> String {
    let Some(agent) = agent_of(cmd) else { return cmd.to_string() };
    let cmd = cmd.trim();
    let id = resume.filter(|r| r.kind == agent && valid_id(&r.id)).map(|r| r.id.as_str());
    match agent {
        "claude" => {
            let mut out = cmd.to_string();
            if let Some(s) = settings {
                out.push_str(&format!(" --settings {s}"));
            }
            if let Some(id) = id {
                out.push_str(&format!(" --resume {id}"));
            }
            out
        }
        "pi" => match (id, fork_of(resume)) {
            (Some(id), Some(from)) => format!("{cmd} --fork {from} --session-id {id}"),
            (Some(id), None) => format!("{cmd} --session-id {id}"),
            _ => cmd.to_string(),
        },
        _ => cmd.to_string(),
    }
}

/// The session to fork, if this launch forks one and the id is safe on a command line.
fn fork_of(resume: Option<&Resume>) -> Option<&str> {
    resume.filter(|r| r.kind == "pi" && valid_id(&r.id)).and_then(|r| r.fork.as_deref()).filter(|f| valid_id(f))
}

const SETTINGS_VAR: &str = "TRICODE_CLAUDE_SETTINGS";
const NOTE_VAR: &str = "TRICODE_PI_NOTE";
/// pi's first message after following its tab to a Worktree, so it carries on without being asked.
const FORK_NOTE: &str = "tri-code restarted you in the new worktree to continue this conversation: your working directory is now that worktree. Carry on with what you were doing there.";

/// A forked pi with its first message added. It goes in a variable on Windows for the reason the
/// hook's path does (see `launch`).
fn with_note(cmd: String, windows: bool) -> Launch {
    if windows {
        Launch { cmd: format!("{cmd} %{NOTE_VAR}%"), env: vec![(NOTE_VAR.into(), format!("\"{FORK_NOTE}\""))] }
    } else {
        Launch { cmd: format!("{cmd} {}", crate::spawn::sq(FORK_NOTE)), env: Vec::new() }
    }
}

/// What a tab's command becomes when it starts locally.
pub fn launch(app: &AppHandle, cmd: &str, resume: Option<&Resume>) -> Launch {
    if agent_of(cmd) != Some("claude") {
        let built = build(cmd, resume, None);
        return if agent_of(cmd) == Some("pi") && fork_of(resume).is_some() { with_note(built, cfg!(windows)) } else { Launch { cmd: built, env: Vec::new() } };
    }
    let Some(file) = hook_settings(app) else {
        return Launch { cmd: build(cmd, resume, None), env: Vec::new() };
    };
    let path = file.to_string_lossy().into_owned();
    if cfg!(windows) {
        // The PTY layer backslash-escapes quotes in the arguments it gives cmd.exe, which cmd doesn't
        // read. A variable holding the quoted path gets there intact, spaces and all.
        let reference = format!("%{SETTINGS_VAR}%");
        Launch { cmd: build(cmd, resume, Some(&reference)), env: vec![(SETTINGS_VAR.into(), format!("\"{path}\""))] }
    } else {
        Launch { cmd: build(cmd, resume, Some(&crate::spawn::sq(&path))), env: Vec::new() }
    }
}

/// The settings file that adds the hook, written if needed. `None` if the hook couldn't run anyway.
fn hook_settings(app: &AppHandle) -> Option<std::path::PathBuf> {
    if !agent_setup::node_present() {
        return None;
    }
    let script = agent_setup::shim_path(app).ok()?.with_file_name("session-hook.mjs");
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("claude-session-hook.json");
    let json = hook_json(&script.to_string_lossy());
    if std::fs::read_to_string(&file).ok().as_deref() != Some(&json) {
        std::fs::write(&file, &json).ok()?;
    }
    Some(file)
}

fn hook_json(script: &str) -> String {
    // Forward slashes read the same in every shell Claude may run a hook through.
    let command = format!("node \"{}\"", script.replace('\\', "/"));
    serde_json::json!({
        "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] }] }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: &str, id: &str) -> Resume {
        Resume { kind: kind.into(), id: id.into(), fork: None }
    }

    const ID: &str = "0b6b1c1e-7a11-4a57-9d6a-2f9a4c3e8f10";
    const OLD: &str = "01a186b9-071f-779e-818b-5c57baf79c7b";

    #[test]
    fn a_followed_pi_forks_its_old_session_into_the_new_id() {
        let f = Resume { fork: Some(OLD.into()), ..r("pi", ID) };
        assert_eq!(build("pi", Some(&f), None), format!("pi --fork {OLD} --session-id {ID}"));
    }

    #[test]
    fn a_fork_id_that_could_run_something_is_ignored() {
        let f = Resume { fork: Some("a & calc".into()), ..r("pi", ID) };
        assert_eq!(build("pi", Some(&f), None), format!("pi --session-id {ID}"));
        assert!(fork_of(Some(&f)).is_none());
    }

    #[test]
    fn only_pi_forks() {
        let f = Resume { fork: Some(OLD.into()), ..r("claude", ID) };
        assert_eq!(build("claude", Some(&f), None), format!("claude --resume {ID}"));
    }

    #[test]
    fn the_note_reaches_pi_as_one_argument() {
        let w = with_note("pi".into(), true);
        assert_eq!(w.cmd, format!("pi %{NOTE_VAR}%"));
        assert_eq!(w.env, vec![(NOTE_VAR.to_string(), format!("\"{FORK_NOTE}\""))]);
        // Inside the quotes cmd.exe still reads these, and a shell reads the last.
        assert!(!FORK_NOTE.contains(['"', '%', '^', '\'', '&', '|', '<', '>', '(', ')']));
        assert_eq!(with_note("pi".into(), false).cmd, format!("pi '{FORK_NOTE}'"));
    }

    #[test]
    fn claude_gets_the_hook_and_its_session() {
        assert_eq!(build("claude", None, Some("%S%")), "claude --settings %S%");
        assert_eq!(build("claude --model opus", Some(&r("claude", ID)), Some("%S%")), format!("claude --model opus --settings %S% --resume {ID}"));
        assert_eq!(build("claude", Some(&r("claude", ID)), None), format!("claude --resume {ID}"));
    }

    #[test]
    fn pi_takes_its_id_up_front() {
        assert_eq!(build("pi", Some(&r("pi", ID)), None), format!("pi --session-id {ID}"));
        assert_eq!(build("pi", None, None), "pi");
    }

    #[test]
    fn a_session_of_another_agent_is_ignored() {
        assert_eq!(build("pi", Some(&r("claude", ID)), None), "pi");
    }

    /// state.json is a file anyone with the account can edit; an id must not become a command.
    #[test]
    fn an_id_that_could_run_something_is_refused() {
        for bad in ["a & calc", "a;rm", "$(x)", "%PATH%", "a b", "", "a\"b", &"x".repeat(129)] {
            assert!(!valid_id(bad), "{bad}");
            assert_eq!(build("pi", Some(&r("pi", bad)), None), "pi");
        }
        assert!(valid_id(ID));
    }

    #[test]
    fn commands_it_cannot_safely_extend_run_as_typed() {
        for cmd in ["claude && echo hi", "claude | tee log", "lazygit", "npm run dev", "claude --resume abc", "claude -p hello", "claude --settings x.json", "pi --no-session", "pi -c", "\"claude\"", "my-claude"] {
            assert_eq!(build(cmd, Some(&r("claude", ID)), Some("%S%")), cmd, "{cmd}");
        }
    }

    #[test]
    fn the_hook_file_runs_the_script() {
        let v: serde_json::Value = serde_json::from_str(&hook_json(r"C:\Program Files\tri-code\mcp\session-hook.mjs")).unwrap();
        let command = v["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(command, "node \"C:/Program Files/tri-code/mcp/session-hook.mjs\"");
    }
}
