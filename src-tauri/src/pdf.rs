//! Native PDF export: a hidden webview loads the export HTML (through the mdfile:// protocol), then the
//! platform print engine writes the PDF without a dialog:
//!   Linux   — WebKitGTK `WebKitPrintOperation` + GTK print settings "Print to File" (tested)
//!   Windows — WebView2 `ICoreWebView2_7::PrintToPdf` (compile-checked only)
//!   macOS   — `WKWebView printOperationWithPrintInfo:` with an NSPrintSaveJob disposition (compile-checked only)
//! Any error is returned to the frontend, which then falls back to the system print dialog.
use std::sync::mpsc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

type Tx = mpsc::Sender<Result<(), String>>;

/// URL of a local file through the mdfile protocol (Windows serves custom schemes as http://<scheme>.localhost)
fn mdfile_url(path: &std::path::Path) -> Result<tauri::Url, String> {
    let p = path.to_string_lossy().replace('\\', "/");
    let enc = percent_encoding::utf8_percent_encode(p.trim_start_matches('/'), percent_encoding::NON_ALPHANUMERIC)
        .to_string().replace("%2F", "/").replace("%2E", ".").replace("%2D", "-").replace("%5F", "_");
    let base = if cfg!(windows) { "http://mdfile.localhost/" } else { "mdfile://localhost/" };
    format!("{base}{enc}").parse().map_err(|e: url::ParseError| e.to_string())
}

pub async fn export_pdf(app: tauri::AppHandle, html: String, out: String) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("mdnest-export-{}.html", std::process::id()));
    std::fs::write(&tmp, html).map_err(|e| e.to_string())?;
    let url = mdfile_url(&tmp)?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let label = format!("pdf-export-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let tx_load = tx.clone();
    let out = out.clone();
    let printed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(url))
        .title("MD Nest PDF export")
        .visible(false)
        .inner_size(900.0, 1200.0)
        .on_page_load(move |wv, payload| {
            if payload.event() != PageLoadEvent::Finished || printed.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
            let tx = tx_load.clone();
            let out = out.clone();
            let win = wv.clone();
            let _ = wv.with_webview(move |pw| {
                if let Err(e) = print_to_pdf(pw, win.clone(), out, tx.clone()) { let _ = tx.send(Err(e)); let _ = win.destroy(); }
            });
        })
        .build()
        .map_err(|e| e.to_string())?;
    let res = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(90)))
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    match res {
        Ok(r) => r,
        Err(_) => Err("PDF export timed out".into()),
    }
}

#[cfg(target_os = "linux")]
fn print_to_pdf(pw: tauri::webview::PlatformWebview, win: tauri::WebviewWindow, out: String, tx: Tx) -> Result<(), String> {
    use webkit2gtk::PrintOperationExt;
    let out_uri = format!("file://{}", percent_encoding::utf8_percent_encode(&out, percent_encoding::CONTROLS).to_string().replace(' ', "%20"));
    let view: webkit2gtk::WebView = pw.inner();
    let settings = gtk::PrintSettings::new();
    settings.set_printer("Print to File");
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&out_uri));
    let setup = gtk::PageSetup::new();
    setup.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
    setup.set_top_margin(15.0, gtk::Unit::Mm); setup.set_bottom_margin(15.0, gtk::Unit::Mm);
    setup.set_left_margin(14.0, gtk::Unit::Mm); setup.set_right_margin(14.0, gtk::Unit::Mm);
    let op = webkit2gtk::PrintOperation::new(&view);
    op.set_print_settings(&settings);
    op.set_page_setup(&setup);
    let (tx_ok, tx_err) = (tx.clone(), tx);
    let (w1, w2) = (win.clone(), win);
    op.connect_finished(move |_| { let _ = tx_ok.send(Ok(())); let _ = w1.destroy(); });
    op.connect_failed(move |_, err| { let _ = tx_err.send(Err(err.to_string())); let _ = w2.destroy(); });
    op.print();
    Ok(())
}

#[cfg(windows)]
fn print_to_pdf(pw: tauri::webview::PlatformWebview, win: tauri::WebviewWindow, out: String, tx: Tx) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};
    let e = |x: windows::core::Error| x.to_string();
    unsafe {
        let core = pw.controller().CoreWebView2().map_err(e)?;
        let wv7: ICoreWebView2_7 = core.cast().map_err(e)?;
        let env6: ICoreWebView2Environment6 = core.cast::<ICoreWebView2_2>().map_err(e)?.Environment().map_err(e)?.cast().map_err(e)?;
        let ps = env6.CreatePrintSettings().map_err(e)?;
        // A4 in inches, margins 15/14 mm
        ps.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT).map_err(e)?;
        ps.SetPageWidth(8.27).map_err(e)?; ps.SetPageHeight(11.69).map_err(e)?;
        ps.SetMarginTop(0.59).map_err(e)?; ps.SetMarginBottom(0.59).map_err(e)?;
        ps.SetMarginLeft(0.55).map_err(e)?; ps.SetMarginRight(0.55).map_err(e)?;
        ps.SetShouldPrintBackgrounds(true).map_err(e)?;
        ps.SetShouldPrintHeaderAndFooter(false).map_err(e)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
            let _ = tx.send(match hr { Err(err) => Err(err.to_string()), Ok(()) if ok => Ok(()), Ok(()) => Err("PrintToPdf failed".into()) });
            let _ = win.destroy();
            Ok(())
        }));
        wv7.PrintToPdf(&HSTRING::from(out.as_str()), &ps, &handler).map_err(e)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn print_to_pdf(pw: tauri::webview::PlatformWebview, win: tauri::WebviewWindow, out: String, tx: Tx) -> Result<(), String> {
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSWindow};
    use objc2_foundation::{NSCopying, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    let _ = std::fs::remove_file(&out);
    unsafe {
        let view: &WKWebView = &*(pw.inner() as *const WKWebView);
        let window: &NSWindow = &*(pw.ns_window() as *const NSWindow);
        let info = NSPrintInfo::sharedPrintInfo().copy();
        // A4 portrait in points, margins 15/14 mm
        info.setPaperSize(NSSize::new(595.28, 841.89));
        info.setTopMargin(42.5); info.setBottomMargin(42.5); info.setLeftMargin(39.7); info.setRightMargin(39.7);
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&out));
        let obj: &AnyObject = url.as_ref();
        info.dictionary().setObject_forKey(obj, ProtocolObject::from_ref(NSPrintJobSavingURL));
        let op = view.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        // WKWebView renders out of process: the print view needs a frame, and only the modal variant prints content
        if let Some(v) = op.view() { v.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(595.28, 841.89))); }
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(window, None, None, std::ptr::null_mut());
    }
    // no delegate callback: wait until the PDF file exists and its size is stable
    std::thread::spawn(move || {
        let (mut last, mut stable) = (0u64, 0);
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(100));
            let len = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            if len > 0 && len == last { stable += 1; if stable >= 10 { let _ = tx.send(Ok(())); let _ = win.destroy(); return; } } else { stable = 0; }
            last = len;
        }
        let _ = tx.send(Err("macOS print-to-PDF produced no file".into())); let _ = win.destroy();
    });
    Ok(())
}
