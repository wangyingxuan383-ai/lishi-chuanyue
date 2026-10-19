#[derive(serde::Serialize)]
pub struct PdfHeading {
    pub title: String,
    pub page: usize,
}
#[derive(serde::Serialize)]
pub struct PdfText {
    pub pages: Vec<String>,
    pub headings: Vec<PdfHeading>,
}
/// Shared by the native application and the loopback-only development bridge.
pub fn extract(bytes: &[u8]) -> Result<PdfText, &'static str> {
    if bytes.len() > 64 * 1024 * 1024 || !bytes.starts_with(b"%PDF-") {
        return Err("PDF 文件无效或超过 64 MiB");
    }
    let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .map_err(|_| "无法提取 PDF 文字，文件可能受保护、损坏，或使用了暂不支持的字体编码")?
        .map_err(|_| "无法提取 PDF 文字，文件可能受保护、损坏，或使用了暂不支持的字体编码")?;
    if pages.iter().map(|p| p.len()).sum::<usize>() > 96 * 1024 * 1024 {
        return Err("PDF 文字过多，请拆分后导入");
    }
    let headings = std::panic::catch_unwind(|| {
        lopdf::Document::load_mem(bytes)
            .ok()
            .and_then(|doc| doc.get_toc().ok())
            .map(|toc| {
                toc.toc
                    .into_iter()
                    .filter(|entry| entry.page > 0 && entry.page <= pages.len())
                    .map(|entry| PdfHeading {
                        title: entry.title,
                        page: entry.page,
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
    .unwrap_or_default();
    Ok(PdfText { pages, headings })
}
