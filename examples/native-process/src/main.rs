//! Standalone stdio process; no host SDK, dynamic library or device access.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        // Bound input before allocating the next chunk.
        loop {
            let bytes = match input.fill_buf() {
                Ok(b) if !b.is_empty() => b,
                _ => return,
            };
            let count = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(bytes.len());
            if line.len() + count > 65536 {
                return;
            }
            line.extend_from_slice(&bytes[..count]);
            input.consume(count);
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        let request: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => return,
        };
        if request["jsonrpc"] != "2.0" {
            return;
        }
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"protocolVersion":1}),
            Some("echo") => request["params"].clone(),
            Some("sum") => {
                let Some(values) = request["params"]["values"].as_array() else {
                    return;
                };
                let Some(numbers) = values.iter().map(Value::as_f64).collect::<Option<Vec<_>>>()
                else {
                    return;
                };
                json!({"sum":numbers.iter().sum::<f64>(),"count":numbers.len()})
            }
            _ => {
                if writeln!(output,"{}",json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Unknown method"}})).is_err(){return}
                let _ = output.flush();
                continue;
            }
        };
        if writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        )
        .is_err()
            || output.flush().is_err()
        {
            return;
        }
    }
}
