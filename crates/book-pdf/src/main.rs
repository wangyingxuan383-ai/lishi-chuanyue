use std::io::{Read, Write};
fn main() {
    let mut bytes = Vec::new();
    let result = std::io::stdin()
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 PDF")
        .and_then(|_| book_pdf::extract(&bytes));
    // Never return parser diagnostics, paths or embedded file data as errors.
    let output = match result {
        Ok(extracted) => serde_json::json!(extracted),
        Err(error) => serde_json::json!({"error": error}),
    };
    let _ = std::io::stdout().write_all(output.to_string().as_bytes());
}
