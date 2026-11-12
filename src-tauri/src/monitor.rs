//! The Monitor Window: what a project's host is doing (CPU, memory, network, disks, processes),
//! sampled on a timer, and ending a process with everything it started.
//!
//! - This machine is read through sysinfo, in a thread per window.
//! - An ssh host is read from `/proc`, so it has to be Linux. One ssh connection stays open and the
//!   host prints a frame every interval (see `remote_script`). A new ssh every second would cost a
//!   handshake each time. The counters that only mean something as a difference (CPU ticks, bytes)
//!   are diffed here against the previous frame.
//!
//! `monitor_start` streams `Snapshot`s until `monitor_stop`. `monitor_end` ends a process tree, but
//! only if the pid still belongs to the process the window showed (`Proc::born`).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Disks, Networks, Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind, Users};
use tauri::ipc::Channel;

use crate::leftovers::{end_tree, is_host, norm, place_of, under};
use crate::remote;
use crate::spawn::{expand_home, sq};

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    /// Its command line; the name when that can't be read.
    pub cmd: String,
    pub user: String,
    /// Percent of one core since the last sample, as top counts it: 250 is two and a half cores busy.
    pub cpu: f32,
    /// Resident bytes.
    pub mem: u64,
    /// When it started, in Unix seconds.
    pub start: u64,
    /// With the pid, this names one process and no other: a reused pid gets a different one.
    /// `monitor_end` checks it.
    pub born: u64,
    pub cwd: Option<String>,
    /// It works in, runs from, or names a path under the project's folder (as Leftovers tests).
    pub mine: bool,
    /// Why it isn't offered to end: "tri-code" (the app, its terminal host, the ssh behind this
    /// window) or "system" (the kernel's, init, Windows' own).
    pub guard: Option<&'static str>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Disk {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    /// Bytes a second, where the host says.
    pub read: Option<u64>,
    pub write: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub os: String,
    pub host_name: String,
    /// Seconds.
    pub uptime: u64,
    /// 1, 5 and 15 minutes; Windows has none.
    pub load: Option<[f64; 3]>,
    /// Percent of the whole machine.
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub mhz: Option<u64>,
    pub mem_total: u64,
    pub mem_used: u64,
    /// What the OS can give back on demand: available minus free.
    pub mem_cached: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// Bytes a second, over every interface but loopback.
    pub rx: u64,
    pub tx: u64,
    pub disks: Vec<Disk>,
    pub procs: Vec<Proc>,
}

/// The project folders worth matching: a drive or the home folder would match nearly everything.
fn project_dirs(dirs: &[String], home: Option<&str>) -> Vec<String> {
    dirs.iter()
        .map(|d| match (home, d.strip_prefix('~')) {
            (Some(h), Some(rest)) if rest.is_empty() || rest.starts_with('/') => format!("{h}{rest}"),
            _ => expand_home(d),
        })
        .map(|d| norm(&d))
        .filter(|d| d.matches('/').count() >= 2 && *d != norm(home.unwrap_or(&expand_home("~"))))
        .collect()
}

fn per_second(delta: u64, secs: f64) -> u64 {
    if secs > 0.0 { (delta as f64 / secs) as u64 } else { 0 }
}

// ── this machine ─────────────────────────────────────────────────────

struct Local {
    sys: System,
    disks: Disks,
    nets: Networks,
    users: Users,
    last: Instant,
    me: Pid,
}

impl Local {
    fn new() -> Result<Self, String> {
        let e = |e: sysinfo::Error| e.to_string();
        let mut l = Local {
            sys: System::new().map_err(e)?,
            disks: Disks::new_with_refreshed_list().map_err(e)?,
            nets: Networks::new_with_refreshed_list().map_err(e)?,
            users: Users::new_with_refreshed_list().map_err(e)?,
            last: Instant::now(),
            me: Pid::from_u32(std::process::id()),
        };
        // CPU use is a difference between two refreshes: this is the first.
        l.refresh();
        Ok(l)
    }

    fn refresh(&mut self) {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        // A command line or folder rarely changes, and reading another process's is the slow part.
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_user(UpdateKind::OnlyIfNotSet);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        self.disks.refresh(true);
        self.nets.refresh(true);
    }

    fn guard(&self, p: &Process) -> Option<&'static str> {
        let pid = p.pid().as_u32();
        if p.pid() == self.me || p.parent() == Some(self.me) || is_host(p) {
            Some("tri-code")
        } else if (cfg!(windows) && pid <= 4) || (!cfg!(windows) && pid <= 1) {
            Some("system")
        } else {
            None
        }
    }

    fn sample(&mut self, dirs: &[String]) -> Snapshot {
        self.refresh();
        let secs = self.last.elapsed().as_secs_f64();
        self.last = Instant::now();
        let dirs = project_dirs(dirs, None);
        let sys = &self.sys;
        let procs = sys
            .processes()
            .values()
            // Linux lists threads as processes too; pid 0 is Windows' idle time, not a process.
            .filter(|p| p.thread_kind().is_none() && p.pid().as_u32() != 0)
            .map(|p| {
                let cmd = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ");
                let name = p.name().to_string_lossy().into_owned();
                Proc {
                    pid: p.pid().as_u32(),
                    ppid: p.parent().map_or(0, |x| x.as_u32()),
                    cmd: if cmd.is_empty() { name.clone() } else { cmd },
                    name,
                    user: p.user_id().and_then(|u| self.users.get_user_by_id(u)).map(|u| u.name().to_string()).unwrap_or_default(),
                    cpu: p.cpu_usage(),
                    mem: p.memory(),
                    start: p.start_time(),
                    born: p.start_time(),
                    cwd: p.cwd().map(|c| c.to_string_lossy().into_owned()).filter(|c| !c.is_empty()),
                    mine: place_of(p, &dirs).is_some(),
                    guard: self.guard(p),
                }
            })
            .collect();
        let (mut rx, mut tx) = (0, 0);
        for (name, n) in &self.nets {
            if !is_loopback(&name.to_string_lossy()) {
                rx += n.received();
                tx += n.transmitted();
            }
        }
        let mut seen = HashSet::new();
        let disks = self
            .disks
            .iter()
            .filter(|d| d.total_space() > 0 && seen.insert(d.mount_point().to_path_buf()))
            .map(|d| {
                let u = d.usage();
                Disk {
                    mount: d.mount_point().to_string_lossy().trim_end_matches('\\').to_string(),
                    total: d.total_space(),
                    used: d.total_space().saturating_sub(d.available_space()),
                    read: Some(per_second(u.read_bytes, secs)),
                    write: Some(per_second(u.written_bytes, secs)),
                }
            })
            .collect();
        let load = (!cfg!(windows)).then(|| System::load_average().ok()).flatten().map(|l| [l.one, l.five, l.fifteen]);
        Snapshot {
            os: System::long_os_version().or_else(|_| System::name()).unwrap_or_default(),
            host_name: System::host_name().unwrap_or_default(),
            uptime: System::uptime().unwrap_or(0),
            load,
            cpu: sys.global_cpu_usage(),
            cores: sys.cpus().iter().map(|c| c.usage()).collect(),
            mhz: sys.cpus().first().map(|c| c.frequency()).filter(|&f| f > 0),
            mem_total: sys.total_memory(),
            mem_used: sys.used_memory(),
            mem_cached: sys.available_memory().saturating_sub(sys.free_memory()),
            swap_total: sys.total_swap(),
            swap_used: sys.used_swap(),
            rx: per_second(rx, secs),
            tx: per_second(tx, secs),
            disks,
            procs,
        }
    }
}

fn is_loopback(name: &str) -> bool {
    name == "lo" || name.to_lowercase().contains("loopback")
}

/// End `pid` and what it started on this machine, if it is still the process born at `born`.
fn end_local(pid: u32, born: u64) -> Result<(), String> {
    let mut l = Local::new()?;
    let p = l.sys.process(Pid::from_u32(pid)).ok_or("it has already ended")?;
    if p.start_time() != born {
        return Err("it has already ended (its pid now belongs to another process)".into());
    }
    if let Some(g) = l.guard(p) {
        return Err(format!("it is {g}'s"));
    }
    end_tree(&l.sys, pid);
    std::thread::sleep(Duration::from_millis(300));
    l.sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    match l.sys.process(Pid::from_u32(pid)) {
        Some(p) if p.start_time() == born => Err("it is still running: it may belong to another user or need admin rights".into()),
        _ => Ok(()),
    }
}

// ── an ssh host ──────────────────────────────────────────────────────

/// Marks the start of each section of a frame, and `\x1eend` its end.
const MARK: char = '\u{1e}';

/// The loop that runs on the host, printing a frame every `every` seconds. Its first line, `$$`,
/// lets the window leave out this script's own processes. It runs beside a reader of ssh's stdin,
/// which ends with the connection and takes the loop with it (as docker.rs does with a log stream).
fn remote_script(every: u32) -> String {
    let frame = [
        r#"printf '\036head\n'; echo $$; echo "$HOME"; cat /proc/uptime /proc/loadavg; getconf CLK_TCK; getconf PAGESIZE; hostname; (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -sr)}")"#,
        r"printf '\036stat\n'; cat /proc/stat",
        r"printf '\036mem\n'; cat /proc/meminfo",
        r"printf '\036net\n'; cat /proc/net/dev",
        r"printf '\036io\n'; cat /proc/diskstats 2>/dev/null",
        r"printf '\036df\n'; df -kP 2>/dev/null",
        r"printf '\036procs\n'; cat /proc/[0-9]*/stat 2>/dev/null",
        r"printf '\036ps\n'; ps -eww -o pid=,user:32=,args= 2>/dev/null",
        r"printf '\036cwd\n'; ls -l /proc/[0-9]*/cwd 2>/dev/null",
        r"printf '\036end\n'",
    ]
    .join("; ");
    let inner = format!(
        "export LC_ALL=C; [ -r /proc/stat ] || {{ echo \"no /proc: $(uname -s) isn't Linux\" >&2; exit 9; }}; \
         exec 3<&0; while :; do {frame}; sleep {every}; done & p=$!; (cat <&3 >/dev/null 2>&1; kill $p 2>/dev/null) & w=$!; \
         wait $p; r=$?; kill $w 2>/dev/null; exit $r"
    );
    // ssh hands the script to the user's login shell, which may not be sh.
    format!("exec /bin/sh -c {}", sq(&inner))
}

/// One process's `/proc/<pid>/stat`.
#[derive(Debug, PartialEq)]
struct Stat {
    pid: u32,
    comm: String,
    ppid: u32,
    /// utime + stime, in clock ticks.
    ticks: u64,
    /// Clock ticks after boot.
    born: u64,
    rss_pages: u64,
}

/// The name sits in parentheses and may hold spaces or parentheses itself, so the fields are
/// counted from the last `)`.
fn parse_stat(line: &str) -> Option<Stat> {
    let (head, tail) = line.rsplit_once(')')?;
    let (pid, comm) = head.split_once(" (")?;
    let f: Vec<&str> = tail.split_whitespace().collect();
    let n = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok());
    // `tail` starts at field 3 (state): utime is field 14, starttime 22, rss 24.
    Some(Stat {
        pid: pid.trim().parse().ok()?,
        comm: comm.to_string(),
        ppid: n(1)? as u32,
        ticks: n(11)? + n(12)?,
        born: n(19)?,
        rss_pages: n(21)?,
    })
}

/// `ps -o pid=,user=,args=`: pid to (user, command line).
fn parse_ps(text: &str) -> HashMap<u32, (String, String)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some((pid, rest)) = line.split_once(char::is_whitespace) else { continue };
        let Ok(pid) = pid.parse() else { continue };
        let rest = rest.trim_start();
        let (user, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        out.insert(pid, (user.to_string(), args.trim().to_string()));
    }
    out
}

/// `ls -l /proc/*/cwd`: pid to working folder, for the processes the user may read.
fn parse_cwds(text: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let Some(at) = line.find(" /proc/") else { continue };
        let Some((pid, to)) = line[at + 7..].split_once("/cwd -> ") else { continue };
        if let Ok(pid) = pid.parse() {
            out.insert(pid, to.to_string());
        }
    }
    out
}

/// The real filesystems of `df -kP`, once each: (device, mount, total bytes, used bytes).
fn parse_df(text: &str) -> Vec<(String, String, u64, u64)> {
    let mut out: Vec<(String, String, u64, u64)> = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 || !f[0].starts_with("/dev/") || f[0].starts_with("/dev/loop") || out.iter().any(|d| d.0 == f[0]) {
            continue;
        }
        let (Ok(total), Ok(used)) = (f[1].parse::<u64>(), f[2].parse::<u64>()) else { continue };
        out.push((f[0].to_string(), f[5..].join(" "), total * 1024, used * 1024));
    }
    out
}

/// `/proc/diskstats`: device name to (bytes read, bytes written) since boot.
fn parse_io(text: &str) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 {
            continue;
        }
        let (Ok(r), Ok(w)) = (f[5].parse::<u64>(), f[9].parse::<u64>()) else { continue };
        out.insert(f[2].to_string(), (r * 512, w * 512));
    }
    out
}

/// `/proc/net/dev`: bytes received and sent since boot, over every interface but loopback.
fn parse_net(text: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0, 0);
    for line in text.lines() {
        let Some((name, nums)) = line.split_once(':') else { continue };
        if is_loopback(name.trim()) {
            continue;
        }
        let f: Vec<u64> = nums.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if f.len() >= 9 {
            rx += f[0];
            tx += f[8];
        }
    }
    (rx, tx)
}

/// `/proc/meminfo` in bytes.
fn parse_mem(text: &str) -> HashMap<&str, u64> {
    text.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k, v.split_whitespace().next()?.parse::<u64>().ok()? * 1024))
        })
        .collect()
}

/// `/proc/stat`'s cpu lines as (busy, total) ticks, the whole machine first; and its boot time.
fn parse_cpu(text: &str) -> (Vec<(u64, u64)>, u64) {
    let mut cpus = Vec::new();
    let mut btime = 0;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("btime ") {
            btime = v.trim().parse().unwrap_or(0);
        } else if line.starts_with("cpu") {
            // user nice system idle iowait irq softirq steal; guest time is already in user.
            let f: Vec<u64> = line.split_whitespace().skip(1).take(8).filter_map(|v| v.parse().ok()).collect();
            let total: u64 = f.iter().sum();
            let idle = f.get(3).copied().unwrap_or(0) + f.get(4).copied().unwrap_or(0);
            cpus.push((total - idle, total));
        }
    }
    (cpus, btime)
}

/// What the previous frame said, for the counters that only mean something as a difference.
#[derive(Default)]
struct Prev {
    uptime: f64,
    cpus: Vec<(u64, u64)>,
    /// (pid, born) to ticks.
    procs: HashMap<(u32, u64), u64>,
    net: (u64, u64),
    io: HashMap<String, (u64, u64)>,
}

fn sections(frame: &str) -> HashMap<&str, &str> {
    frame
        .split(MARK)
        .filter_map(|s| {
            let (name, body) = s.split_once('\n').unwrap_or((s, ""));
            (!name.is_empty()).then_some((name.trim(), body))
        })
        .collect()
}

fn pct(now: (u64, u64), was: Option<&(u64, u64)>) -> f32 {
    let Some(was) = was else { return 0.0 };
    let total = now.1.saturating_sub(was.1);
    if total == 0 { 0.0 } else { (now.0.saturating_sub(was.0) as f64 / total as f64 * 100.0) as f32 }
}

fn parse_frame(frame: &str, prev: &mut Prev, dirs: &[String]) -> Result<Snapshot, String> {
    let s = sections(frame);
    let head: Vec<&str> = s.get("head").ok_or("no head in the frame")?.lines().collect();
    let line = |i: usize| head.get(i).copied().unwrap_or("");
    let me: u32 = line(0).trim().parse().unwrap_or(0);
    let home = line(1).trim();
    let uptime: f64 = line(2).split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let load: Vec<f64> = line(3).split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect();
    let clk: f64 = line(4).trim().parse().unwrap_or(100.0);
    let page: u64 = line(5).trim().parse().unwrap_or(4096);
    // Measured on the host, so ssh's own delays don't skew the rates.
    let secs = if prev.uptime > 0.0 { uptime - prev.uptime } else { 0.0 };

    let (cpus, btime) = parse_cpu(s.get("stat").copied().unwrap_or(""));
    let mut usage: Vec<f32> = cpus.iter().enumerate().map(|(i, c)| pct(*c, prev.cpus.get(i))).collect();
    let cpu = if usage.is_empty() { 0.0 } else { usage.remove(0) };

    let mem = parse_mem(s.get("mem").copied().unwrap_or(""));
    let m = |k: &str| mem.get(k).copied().unwrap_or(0);
    let available = if mem.contains_key("MemAvailable") { m("MemAvailable") } else { m("MemFree") + m("Cached") };

    let net = parse_net(s.get("net").copied().unwrap_or(""));
    let io = parse_io(s.get("io").copied().unwrap_or(""));
    let disks = parse_df(s.get("df").copied().unwrap_or(""))
        .into_iter()
        .map(|(dev, mount, total, used)| {
            let name = dev.trim_start_matches("/dev/").to_string();
            let rate = |f: fn(&(u64, u64)) -> u64| {
                let now = io.get(&name)?;
                let was = prev.io.get(&name)?;
                Some(per_second(f(now).saturating_sub(f(was)), secs))
            };
            Disk { mount, total, used, read: rate(|x| x.0), write: rate(|x| x.1) }
        })
        .collect();

    let stats: Vec<Stat> = s.get("procs").copied().unwrap_or("").lines().filter_map(parse_stat).collect();
    // This script and what it runs aren't the host's work: leave them out, and keep the ssh behind
    // it from being ended from the window it feeds.
    let mut ours: HashSet<u32> = HashSet::from([me]);
    let mut grew = true;
    while grew {
        grew = false;
        for st in &stats {
            if ours.contains(&st.ppid) && ours.insert(st.pid) {
                grew = true;
            }
        }
    }
    let feeder = stats.iter().find(|st| st.pid == me).map(|st| st.ppid);
    let ps = parse_ps(s.get("ps").copied().unwrap_or(""));
    let cwds = parse_cwds(s.get("cwd").copied().unwrap_or(""));
    let dirs = project_dirs(dirs, (!home.is_empty()).then_some(home));
    let mut ticks = HashMap::new();
    let procs = stats
        .into_iter()
        // Kernel threads are kthreadd (2) and its children.
        .filter(|st| !ours.contains(&st.pid) && st.pid != 2 && st.ppid != 2)
        .map(|st| {
            ticks.insert((st.pid, st.born), st.ticks);
            let cpu = match prev.procs.get(&(st.pid, st.born)) {
                Some(&was) if secs > 0.0 => (st.ticks.saturating_sub(was) as f64 / clk / secs * 100.0) as f32,
                _ => 0.0,
            };
            let (user, args) = ps.get(&st.pid).cloned().unwrap_or_default();
            let cwd = cwds.get(&st.pid).cloned();
            let mine = {
                let mut paths: Vec<String> = cwd.iter().map(|c| norm(c)).collect();
                paths.extend(args.split_whitespace().skip(1).filter(|a| a.contains('/')).map(|a| norm(a.rsplit_once('=').map_or(a, |(_, v)| v))));
                paths.extend(args.split_whitespace().next().filter(|a| a.starts_with('/')).map(norm));
                dirs.iter().any(|d| paths.iter().any(|p| under(p, d)))
            };
            Proc {
                pid: st.pid,
                ppid: st.ppid,
                cmd: if args.is_empty() { st.comm.clone() } else { args },
                name: st.comm,
                user,
                cpu,
                mem: st.rss_pages * page,
                start: btime + (st.born as f64 / clk) as u64,
                born: st.born,
                cwd,
                mine,
                guard: if st.pid == 1 { Some("system") } else if Some(st.pid) == feeder { Some("tri-code") } else { None },
            }
        })
        .collect();

    let snap = Snapshot {
        os: line(7).trim().to_string(),
        host_name: line(6).trim().to_string(),
        uptime: uptime as u64,
        load: (load.len() == 3).then(|| [load[0], load[1], load[2]]),
        cpu,
        cores: usage,
        mhz: None,
        mem_total: m("MemTotal"),
        mem_used: m("MemTotal").saturating_sub(available),
        mem_cached: available.saturating_sub(m("MemFree")),
        swap_total: m("SwapTotal"),
        swap_used: m("SwapTotal").saturating_sub(m("SwapFree")),
        rx: if secs > 0.0 { per_second(net.0.saturating_sub(prev.net.0), secs) } else { 0 },
        tx: if secs > 0.0 { per_second(net.1.saturating_sub(prev.net.1), secs) } else { 0 },
        disks,
        procs,
    };
    *prev = Prev { uptime, cpus, procs: ticks, net, io };
    Ok(snap)
}

/// End `pid` and what it started on `host`, if `/proc` still says it was born at `born`: TERM to the
/// tree, children first, then KILL to whatever is left a second later.
fn end_script(pid: u32, born: u64) -> String {
    let inner = format!(
        r#"born() {{ set -- $(sed 's/^.*) //' /proc/{pid}/stat 2>/dev/null); echo "${{20}}"; }}
[ "$(born)" = {born} ] || {{ echo "it has already ended" >&2; exit 3; }}
t=$(ps -eo pid=,ppid= | awk -v root={pid} '{{ par[$1] = $2 }} END {{ n = 1; q[1] = root; for (i = 1; i <= n; i++) for (p in par) if (par[p] == q[i]) q[++n] = p; for (i = n; i >= 1; i--) printf "%s ", q[i] }}')
kill -TERM $t 2>/dev/null; sleep 1; kill -KILL $t 2>/dev/null; sleep 0.2
[ "$(born)" = {born} ] && {{ echo "it is still running: it may belong to another user" >&2; exit 4; }}
exit 0"#
    );
    format!("exec /bin/sh -c {}", sq(&inner))
}

// ── streams ──────────────────────────────────────────────────────────

struct Running {
    stop: Arc<AtomicBool>,
    child: Option<Arc<Mutex<Child>>>,
    /// Held open: closing it is what ends the loop on the host.
    _stdin: Option<ChildStdin>,
}

impl Running {
    fn end(self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(c) = self.child {
            let _ = c.lock().unwrap().kill();
        }
    }
}

static RUNNING: LazyLock<Mutex<HashMap<String, Running>>> = LazyLock::new(Default::default);

fn stop_id(id: &str) {
    if let Some(r) = RUNNING.lock().unwrap().remove(id) {
        r.end();
    }
}

fn start_local(stop: Arc<AtomicBool>, every: Duration, dirs: Vec<String>, on_sample: Channel<Snapshot>, on_exit: Channel<String>) {
    std::thread::spawn(move || {
        let mut l = match Local::new() {
            Ok(l) => l,
            Err(e) => return void(on_exit.send(e)),
        };
        // The first figures come a moment after the priming refresh, not a whole interval later.
        std::thread::sleep(Duration::from_millis(400));
        while !stop.load(Ordering::Relaxed) {
            let snap = l.sample(&dirs);
            if stop.load(Ordering::Relaxed) || on_sample.send(snap).is_err() {
                return;
            }
            let until = Instant::now() + every;
            while Instant::now() < until && !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    });
}

fn void<T>(_: T) {}

fn start_remote(host: &str, stop: Arc<AtomicBool>, every: u32, dirs: Vec<String>, on_sample: Channel<Snapshot>, on_exit: Channel<String>) -> Result<Running, String> {
    crate::envssh::check(host)?;
    let mut cmd = remote::command(host, &remote_script(every));
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
    let out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));
    let errors = Arc::new(Mutex::new(String::new()));
    {
        let errors = Arc::clone(&errors);
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            *errors.lock().unwrap() = s;
        });
    }
    let waiter = Arc::clone(&child);
    let stopped = Arc::clone(&stop);
    std::thread::spawn(move || {
        let mut prev = Prev::default();
        let mut frame = String::new();
        let mut reader = BufReader::new(out);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            if line.trim_end() == "\u{1e}end" {
                let parsed = parse_frame(&frame, &mut prev, &dirs);
                frame.clear();
                if stopped.load(Ordering::Relaxed) {
                    break;
                }
                if let Ok(snap) = parsed
                    && on_sample.send(snap).is_err()
                {
                    break;
                }
            } else {
                frame.push_str(&line);
            }
        }
        let status = waiter.lock().unwrap().wait();
        if !stopped.load(Ordering::Relaxed) {
            // Give the stderr reader a moment to finish with what ssh said last.
            std::thread::sleep(Duration::from_millis(100));
            let e = errors.lock().unwrap().trim().to_string();
            let msg = if !e.is_empty() { e } else { format!("the connection ended ({})", status.map_or("?".into(), |s| s.to_string())) };
            let _ = on_exit.send(msg);
        }
    });
    Ok(Running { stop, child: Some(child), _stdin: stdin })
}

/// Sample `host` every `every` seconds until `monitor_stop(id)`. `dirs` are the project's folders,
/// which mark its processes. A failure to start or a dropped connection goes to `on_exit`.
#[tauri::command]
pub async fn monitor_start(id: String, host: String, dirs: Vec<String>, every: u32, on_sample: Channel<Snapshot>, on_exit: Channel<String>) -> Result<(), String> {
    let every = every.clamp(1, 60);
    stop_id(&id);
    let stop = Arc::new(AtomicBool::new(false));
    let running = if is_local(&host) {
        start_local(Arc::clone(&stop), Duration::from_secs(every.into()), dirs, on_sample, on_exit);
        Running { stop, child: None, _stdin: None }
    } else {
        let host2 = host.clone();
        tauri::async_runtime::spawn_blocking(move || start_remote(&host2, stop, every, dirs, on_sample, on_exit)).await.map_err(|e| e.to_string())??
    };
    RUNNING.lock().unwrap().insert(id, running);
    Ok(())
}

#[tauri::command]
pub async fn monitor_stop(id: String) -> Result<(), String> {
    stop_id(&id);
    Ok(())
}

/// End `pid` and everything it started, if it is still the process born at `born`.
#[tauri::command]
pub async fn monitor_end(host: String, pid: u32, born: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || if is_local(&host) { end_local(pid, born) } else { remote::run(&host, &end_script(pid, born)).map(void) })
        .await
        .map_err(|e| e.to_string())?
}

/// End every sampler as the app exits.
pub fn close_all() {
    for (_, r) in RUNNING.lock().unwrap().drain() {
        r.end();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stat_line_counts_its_fields_from_the_last_parenthesis() {
        let line = "4242 (Web Content (2)) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 7 0 98765 1000000 2500 18446744073709551615";
        let s = parse_stat(line).unwrap();
        assert_eq!(s, Stat { pid: 4242, comm: "Web Content (2)".into(), ppid: 1, ticks: 200, born: 98765, rss_pages: 2500 });
        assert!(parse_stat("garbage").is_none());
    }

    #[test]
    fn ps_lines_split_into_user_and_the_whole_command_line() {
        let ps = parse_ps("    1 root     /sbin/init splash\n 3310 waldo    node /home/waldo/shop/server.js --port 3000\n 77 nobody\n");
        assert_eq!(ps[&1], ("root".into(), "/sbin/init splash".into()));
        assert_eq!(ps[&3310], ("waldo".into(), "node /home/waldo/shop/server.js --port 3000".into()));
        assert_eq!(ps[&77], ("nobody".into(), "".into()));
    }

    #[test]
    fn cwd_links_name_their_pid_and_folder() {
        let c = parse_cwds("lrwxrwxrwx 1 waldo waldo 0 Nov 11 10:00 /proc/123/cwd -> /home/waldo/my shop\nls: cannot read symbolic link '/proc/1/cwd': Permission denied\n");
        assert_eq!(c.len(), 1);
        assert_eq!(c[&123], "/home/waldo/my shop");
    }

    #[test]
    fn df_keeps_real_devices_once_and_mounts_with_spaces() {
        let d = parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\ntmpfs 10 0 10 0% /run\n/dev/loop0 5 5 0 100% /snap/x\n/dev/sdb1 200 50 150 25% /mnt/big disk\n/dev/sda1 100 40 60 40% /var/lib/docker\n");
        assert_eq!(d, vec![("/dev/sda1".into(), "/".into(), 102400, 40960), ("/dev/sdb1".into(), "/mnt/big disk".into(), 204800, 51200)]);
    }

    #[test]
    fn network_totals_leave_out_loopback() {
        let t = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes ...\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 200 3 0 0 0 0 0 0\n";
        assert_eq!(parse_net(t), (1000, 200));
    }

    #[test]
    fn a_remote_project_folder_under_home_expands_and_a_bare_home_is_too_broad() {
        let d = project_dirs(&["~/shop".into(), "~".into(), "/srv/app".into()], Some("/home/waldo"));
        assert_eq!(d, vec!["/home/waldo/shop".to_string(), "/srv/app".to_string()]);
    }

    fn frame(uptime: f64, cpu: (u64, u64), net: (u64, u64), node_ticks: u64) -> String {
        let (busy, idle) = cpu;
        format!(
            "\u{1e}head\n500\n/home/waldo\n{uptime} 1.0\n0.50 0.40 0.30 1/100 600\n100\n4096\ndev-box\nUbuntu 24.04 LTS\n\
             \u{1e}stat\ncpu  {busy} 0 0 {idle} 0 0 0 0 0 0\ncpu0 {busy} 0 0 {idle} 0 0 0 0 0 0\nbtime 1700000000\n\
             \u{1e}mem\nMemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 600 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n\
             \u{1e}net\n  eth0: {} 0 0 0 0 0 0 0 {} 0 0 0 0 0 0 0\n\
             \u{1e}procs\n1 (systemd) S 0 1 1 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 1 0 100 0\n\
             2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0 0\n\
             9 (kworker/0:1) I 2 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0 0\n\
             499 (sshd) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 50 0 10 0\n\
             500 (sh) S 499 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 60 0 10 0\n\
             501 (cat) S 500 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 61 0 10 0\n\
             700 (node) S 1 1 1 0 -1 0 0 0 0 0 {node_ticks} 0 0 0 20 0 9 0 3000 0 25 0\n\
             \u{1e}ps\n  700 waldo   node /home/waldo/shop/server.js\n\
             \u{1e}cwd\nlrwxrwxrwx 1 waldo waldo 0 Nov 11 10:00 /proc/700/cwd -> /home/waldo/shop\n",
            net.0, net.1
        )
    }

    #[test]
    fn two_frames_give_rates_and_usage_and_leave_out_the_sampler_and_kernel_threads() {
        let mut prev = Prev::default();
        let dirs = vec!["~/shop".to_string()];
        let first = parse_frame(&frame(100.0, (100, 900), (1000, 500), 50), &mut prev, &dirs).unwrap();
        assert_eq!(first.cpu, 0.0);
        assert_eq!(first.rx, 0);
        // Two seconds later: 100 of 200 ticks busy; node used 100 ticks (1 s at 100 Hz) in 2 s.
        let s = parse_frame(&frame(102.0, (200, 1000), (5000, 900), 150), &mut prev, &dirs).unwrap();
        assert_eq!(s.cpu, 50.0);
        assert_eq!(s.cores, vec![50.0]);
        assert_eq!((s.rx, s.tx), (2000, 200));
        assert_eq!((s.mem_total, s.mem_used, s.mem_cached), (1024000, 409600, 409600));
        assert_eq!(s.swap_used, 25600);
        assert_eq!(s.load, Some([0.5, 0.4, 0.3]));
        assert_eq!((s.os.as_str(), s.host_name.as_str()), ("Ubuntu 24.04 LTS", "dev-box"));
        let pids: Vec<u32> = s.procs.iter().map(|p| p.pid).collect();
        assert_eq!(pids, [1, 499, 700]);
        let node = s.procs.iter().find(|p| p.pid == 700).unwrap();
        assert_eq!(node.cpu, 50.0);
        assert_eq!(node.mem, 25 * 4096);
        assert_eq!(node.start, 1700000000 + 30);
        assert!(node.mine && node.guard.is_none());
        assert_eq!(node.user, "waldo");
        assert_eq!(s.procs.iter().find(|p| p.pid == 1).unwrap().guard, Some("system"));
        assert_eq!(s.procs.iter().find(|p| p.pid == 499).unwrap().guard, Some("tri-code"));
    }

    #[test]
    fn a_reused_pid_starts_its_cpu_from_nothing() {
        let mut prev = Prev::default();
        parse_frame(&frame(100.0, (0, 0), (0, 0), 50), &mut prev, &[]).unwrap();
        let other = frame(101.0, (0, 0), (0, 0), 9000).replace(" 3000 0 25 0", " 3050 0 25 0");
        let s = parse_frame(&other, &mut prev, &[]).unwrap();
        assert_eq!(s.procs.iter().find(|p| p.pid == 700).unwrap().cpu, 0.0);
    }

    #[test]
    fn the_scripts_run_under_sh_whatever_the_login_shell() {
        assert!(remote_script(2).starts_with("exec /bin/sh -c '"));
        assert!(remote_script(2).contains("sleep 2"));
        let e = end_script(700, 3000);
        assert!(e.starts_with("exec /bin/sh -c '") && e.contains("/proc/700/stat") && e.contains("= 3000"));
    }

    /// The frame loop and the end script, run by a real sh on this machine's /proc.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_host_side_scripts_work_on_linux() {
        use std::process::Command;
        let script = remote_script(1);
        let inner = script.strip_prefix("exec /bin/sh -c ").unwrap();
        let mut child = Command::new("sh").args(["-c", &format!("exec /bin/sh -c {inner}")]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let (mut frame, mut line) = (String::new(), String::new());
        while out.read_line(&mut line).unwrap() > 0 && line.trim_end() != "\u{1e}end" {
            frame.push_str(&line);
            line.clear();
        }
        drop(child.stdin.take());
        let _ = child.wait();
        let s = parse_frame(&frame, &mut Prev::default(), &[]).unwrap();
        assert!(s.mem_total > 0 && !s.procs.is_empty() && !s.cores.is_empty());

        let mut sleeper = Command::new("sleep").arg("30").spawn().unwrap();
        let stat = std::fs::read_to_string(format!("/proc/{}/stat", sleeper.id())).unwrap();
        let born = parse_stat(&stat).unwrap().born;
        let end = end_script(sleeper.id(), born + 1);
        let inner = end.strip_prefix("exec /bin/sh -c ").unwrap();
        assert!(!Command::new("sh").args(["-c", &format!("exec /bin/sh -c {inner}")]).status().unwrap().success());
        let end = end_script(sleeper.id(), born);
        let inner = end.strip_prefix("exec /bin/sh -c ").unwrap();
        // The sleeper is our child: until it is reaped it stays a zombie with the same stat.
        let ender = std::thread::spawn(move || Command::new("sh").args(["-c", &format!("exec /bin/sh -c {inner}")]).status().unwrap());
        assert!(sleeper.wait().unwrap().code().is_none());
        let _ = ender.join();
    }

    #[test]
    fn this_machine_samples_itself_and_guards_tri_code() {
        let mut l = Local::new().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let s = l.sample(&[]);
        assert!(s.mem_total > 0 && !s.cores.is_empty());
        let me = s.procs.iter().find(|p| p.pid == std::process::id()).expect("this test's own process");
        assert_eq!(me.guard, Some("tri-code"));
        assert!(end_local(std::process::id(), me.born).is_err());
    }

    #[test]
    fn ending_a_local_process_checks_its_birth_and_takes_its_tree() {
        #[cfg(windows)]
        let mut c = std::process::Command::new("powershell");
        #[cfg(windows)]
        c.args(["-NoProfile", "-Command", "Start-Sleep 30"]);
        #[cfg(not(windows))]
        let mut c = std::process::Command::new("sleep");
        #[cfg(not(windows))]
        c.arg("30");
        let mut child = c.spawn().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let l = Local::new().unwrap();
        let born = l.sys.process(Pid::from_u32(child.id())).unwrap().start_time();
        assert!(end_local(child.id(), born + 5).is_err(), "a different birth is a different process");
        // The child is ours, so it lingers as a zombie on unix until reaped: reap it as it ends.
        let id = child.id();
        let ender = std::thread::spawn(move || end_local(id, born));
        child.wait().unwrap();
        let _ = ender.join();
    }
}
