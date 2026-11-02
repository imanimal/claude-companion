//! The local bridge Claude Code talks to, on 127.0.0.1:47811 (sessions::PORT):
//!   POST /hook   a hook payload, as Claude Code writes it to the hook's stdin
//!   POST /p      Claude's progress estimate: form body `p=40&t=Building the editor` (or ?p=…&t=… on GET)
//!   GET  /state  the sessions the pet shows (JSON), GET /ping → "claude-companion"
//! Requests carrying an Origin header are refused, so a web page can't drive the pet.
//!
//! `claude-companion hook` is the hook command itself (exec form, async, set up by claude.rs): it forwards
//! stdin to /hook and exits 0 whether or not the app is running, so a hook never errors or blocks a turn.
//! Sessions the Claude desktop app starts carry its chat id in CLAUDE_CODE_HOST_SESSION_ID, which hooks
//! inherit; the client sends it as an `X-Host-Session` header and the bridge adds it to the payload as
//! `host_session_id`, so a click on the pill can open that chat.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use crate::sessions::{parse_form, valid_host_session, PORT};

pub fn addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], PORT))
}

/// The hook client: stdin → POST /hook. Never fails.
pub fn hook_client() {
    let mut body = Vec::new();
    let _ = std::io::stdin().take(16 << 20).read_to_end(&mut body);
    if body.is_empty() {
        return;
    }
    let Ok(mut s) = TcpStream::connect_timeout(&addr(), Duration::from_millis(400)) else { return };
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let host = std::env::var("CLAUDE_CODE_HOST_SESSION_ID").ok().filter(|h| valid_host_session(h));
    let head = format!(
        "POST /hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
        body.len(),
        host.map(|h| format!("X-Host-Session: {h}\r\n")).unwrap_or_default()
    );
    if s.write_all(head.as_bytes()).is_ok() && s.write_all(&body).is_ok() {
        let mut sink = [0u8; 256];
        let _ = s.read(&mut sink);
    }
}

pub enum Request {
    Hook(serde_json::Value),
    Progress(u8, Option<String>),
    State,
    Ping,
}

/// Binds the listener. Err when the port is taken (another copy of the app, most likely).
pub fn bind() -> std::io::Result<TcpListener> {
    TcpListener::bind(addr())
}

/// Accept loop: each connection is read, answered and closed on its own thread. `handle` returns the
/// JSON body for /state.
pub fn serve<F>(listener: TcpListener, handle: F)
where
    F: Fn(Request) -> Option<String> + Send + Sync + 'static + Clone,
{
    for conn in listener.incoming().flatten() {
        let h = handle.clone();
        std::thread::spawn(move || {
            let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = one(conn, h);
        });
    }
}

fn one<F: Fn(Request) -> Option<String>>(mut c: TcpStream, handle: F) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = c.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 32 * 1024 {
            return reply(&mut c, 431, "text/plain", "headers too large");
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut it = first.split_whitespace();
    let (method, target) = (it.next().unwrap_or(""), it.next().unwrap_or("/"));
    let mut len = 0usize;
    let mut host = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let k = k.trim().to_ascii_lowercase();
        if k == "origin" {
            return reply(&mut c, 403, "text/plain", "no browsers");
        }
        if k == "content-length" {
            len = v.trim().parse().unwrap_or(0);
        }
        if k == "x-host-session" {
            host = Some(v.trim().to_string());
        }
    }
    if len > 32 << 20 {
        return reply(&mut c, 413, "text/plain", "too large");
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = c.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match (method, path) {
        ("POST", "/hook") => {
            reply(&mut c, 204, "text/plain", "")?;
            if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&body) {
                // sessions.rs checks the id before it keeps it
                if let (Some(h), Some(o)) = (host, v.as_object_mut()) {
                    o.entry("host_session_id").or_insert(h.into());
                }
                handle(Request::Hook(v));
            }
            Ok(())
        }
        (_, "/p") | (_, "/progress") => {
            let form = if body.is_empty() { query.to_string() } else { String::from_utf8_lossy(&body).to_string() };
            let (p, t) = parse_form(&form);
            match p {
                Some(p) => {
                    reply(&mut c, 204, "text/plain", "")?;
                    handle(Request::Progress(p, t));
                    Ok(())
                }
                None => reply(&mut c, 400, "text/plain", "send p=0..100 and optionally t=label"),
            }
        }
        ("GET", "/state") => {
            let s = handle(Request::State).unwrap_or_else(|| "[]".into());
            reply(&mut c, 200, "application/json", &s)
        }
        ("GET", "/ping") | ("GET", "/") => {
            handle(Request::Ping);
            reply(&mut c, 200, "text/plain", "claude-companion")
        }
        _ => reply(&mut c, 404, "text/plain", "not found"),
    }
}

fn reply(c: &mut TcpStream, code: u16, ctype: &str, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let msg = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    c.write_all(msg.as_bytes())?;
    c.flush()
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}
