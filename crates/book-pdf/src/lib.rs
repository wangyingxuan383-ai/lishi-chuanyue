use pdf_extract::{ConvertToFmt, MediaBox, OutputDev, OutputError, PlainTextOutput, Transform};
use std::{cell::RefCell, rc::Rc};

const MAX_TEXT_BYTES: usize = 96 * 1024 * 1024;
const INVALID_TEXT: &str = "无法提取 PDF 文字，文件可能受保护、损坏，或使用了暂不支持的字体编码";

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
    extract_with_cancel(bytes, || false)
}

pub fn extract_with_cancel(bytes: &[u8], cancelled: impl Fn() -> bool) -> Result<PdfText, &'static str> {
    if bytes.len() > 64 * 1024 * 1024 || !bytes.starts_with(b"%PDF-") {
        return Err("PDF 文件无效或超过 64 MiB");
    }
    if cancelled() { return Err("已取消"); }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut document = lopdf::Document::load_mem(bytes).map_err(|_| INVALID_TEXT)?;
        if document.is_encrypted() { document.decrypt("").map_err(|_| INVALID_TEXT)?; }
        let capture = Rc::new(RefCell::new(Capture::default()));
        let writer = Writer { capture: capture.clone(), cancelled: &cancelled };
        let mut output = Pages { text: PlainTextOutput::new(writer.clone()), writer, pages: Vec::new() };
        let extraction = pdf_extract::output_doc(&document, &mut output);
        if cancelled() { return Err("已取消"); }
        if capture.borrow().limit_reached { return Err("PDF 文字过多，请拆分后导入"); }
        extraction.map_err(|_| INVALID_TEXT)?;
        // A broken optional table of contents must not discard intact page text.
        let toc = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| document.get_toc().ok())).ok().flatten();
        if cancelled() { return Err("已取消"); }
        let headings = toc.into_iter().flat_map(|toc| toc.toc)
            .filter(|entry| entry.page > 0 && entry.page <= output.pages.len())
            .map(|entry| PdfHeading { title: entry.title, page: entry.page }).collect();
        Ok(PdfText { pages: output.pages, headings })
    })).map_err(|_| INVALID_TEXT)?
}


#[derive(Default)]
struct Capture {
    page: String,
    bytes: usize,
    limit_reached: bool,
}

#[derive(Clone)]
struct Writer<'a> {
    capture: Rc<RefCell<Capture>>,
    cancelled: &'a dyn Fn() -> bool,
}

impl ConvertToFmt for Writer<'_> {
    type Writer = Self;
    fn convert(self) -> Self { self }
}

impl std::fmt::Write for Writer<'_> {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if (self.cancelled)() { return Err(std::fmt::Error); }
        let mut captured = self.capture.borrow_mut();
        if captured.bytes.saturating_add(text.len()) > MAX_TEXT_BYTES {
            captured.limit_reached = true;
            return Err(std::fmt::Error);
        }
        captured.page.push_str(text);
        captured.bytes += text.len();
        Ok(())
    }
}

struct Pages<'a> {
    writer: Writer<'a>,
    text: PlainTextOutput<Writer<'a>>,
    pages: Vec<String>,
}

impl OutputDev for Pages<'_> {
    fn begin_page(&mut self, number: u32, media: &MediaBox, art: Option<(f64, f64, f64, f64)>) -> Result<(), OutputError> {
        if (self.writer.cancelled)() { return Err(std::fmt::Error.into()); }
        self.text = PlainTextOutput::new(self.writer.clone());
        self.text.begin_page(number, media, art)
    }
    fn end_page(&mut self) -> Result<(), OutputError> {
        self.text.end_page()?;
        self.pages.push(std::mem::take(&mut self.writer.capture.borrow_mut().page));
        Ok(())
    }
    fn output_character(&mut self, transform: &Transform, width: f64, spacing: f64, font: f64, value: &str) -> Result<(), OutputError> {
        self.text.output_character(transform, width, spacing, font, value)
    }
    fn begin_word(&mut self) -> Result<(), OutputError> { self.text.begin_word() }
    fn end_word(&mut self) -> Result<(), OutputError> { self.text.end_word() }
    fn end_line(&mut self) -> Result<(), OutputError> { self.text.end_line() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{content::{Content, Operation}, dictionary, Document, Object, Stream};
    use std::{cell::Cell, fmt::Write};

    #[test]
    fn extraction_keeps_page_boundaries_and_can_cancel_during_text() {
        let mut document = Document::with_version("1.5");
        let pages = document.new_object_id();
        let font = document.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"});
        let resources = document.add_object(dictionary! {"Font" => dictionary! {"F1" => font}});
        let mut children = Vec::new();
        for words in ["First page", "Second page"] {
            let content = Content { operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 12.into()]),
                Operation::new("Td", vec![10.into(), 30.into()]),
                Operation::new("Tj", vec![Object::string_literal(words)]),
                Operation::new("ET", vec![]),
            ] };
            let contents = document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let page = document.add_object(dictionary! {"Type" => "Page", "Parent" => pages, "Contents" => contents});
            children.push(Object::Reference(page));
        }
        document.objects.insert(pages, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => children, "Count" => 2, "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }));
        let root = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
        document.trailer.set("Root", root);
        let mut fixture = Vec::new();
        document.save_to(&mut fixture).unwrap();

        let result = extract(&fixture).unwrap();
        assert_eq!(result.pages.iter().map(|page| page.trim()).collect::<Vec<_>>(), ["First page", "Second page"]);
        let checks = Cell::new(0);
        assert!(matches!(extract_with_cancel(&fixture, || {
            checks.set(checks.get() + 1);
            checks.get() > 3
        }), Err("已取消")));
    }

    #[test]
    fn output_cap_rejects_before_adding_more_text() {
        let capture = Rc::new(RefCell::new(Capture { bytes: MAX_TEXT_BYTES, ..Capture::default() }));
        let mut writer = Writer { capture: capture.clone(), cancelled: &|| false };
        assert!(writer.write_str("再").is_err());
        assert!(capture.borrow().page.is_empty());
        assert!(capture.borrow().limit_reached);
    }
}
