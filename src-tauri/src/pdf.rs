//! Linux PDF export: hidden WebKitGTK webview + WebKitPrintOperation printing to a file.
use std::sync::mpsc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub async fn export_pdf_linux(app: tauri::AppHandle, html: String, out: String) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("mdnest-export-{}.html", std::process::id()));
    std::fs::write(&tmp, html).map_err(|e| e.to_string())?;
    let url_path = percent_encoding::utf8_percent_encode(tmp.to_string_lossy().trim_start_matches('/'), percent_encoding::NON_ALPHANUMERIC)
        .to_string().replace("%2F", "/").replace("%2E", ".").replace("%2D", "-").replace("%5F", "_");
    let url: tauri::Url = format!("mdfile://localhost/{url_path}").parse().map_err(|e: url::ParseError| e.to_string())?;
    let out_uri = format!("file://{}", percent_encoding::utf8_percent_encode(&out, percent_encoding::CONTROLS).to_string().replace(' ', "%20"));
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let label = format!("pdf-export-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let tx_load = tx.clone();
    let printed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(url))
        .title("MD Nest PDF export")
        .visible(false)
        .inner_size(900.0, 1200.0)
        .on_page_load(move |wv, payload| {
            if payload.event() != PageLoadEvent::Finished || printed.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
            let tx = tx_load.clone();
            let out_uri = out_uri.clone();
            let win = wv.clone();
            let _ = wv.with_webview(move |pw| {
                use webkit2gtk::PrintOperationExt;
                let view: webkit2gtk::WebView = pw.inner();
                let settings = gtk::PrintSettings::new();
                settings.set_printer("Print to File");
                settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
                settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&out_uri));
                let setup = gtk::PageSetup::new();
                setup.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
                for (side, mm) in [(gtk::PositionType::Top, 15.0), (gtk::PositionType::Bottom, 15.0), (gtk::PositionType::Left, 14.0), (gtk::PositionType::Right, 14.0)] {
                    match side {
                        gtk::PositionType::Top => setup.set_top_margin(mm, gtk::Unit::Mm),
                        gtk::PositionType::Bottom => setup.set_bottom_margin(mm, gtk::Unit::Mm),
                        gtk::PositionType::Left => setup.set_left_margin(mm, gtk::Unit::Mm),
                        _ => setup.set_right_margin(mm, gtk::Unit::Mm),
                    }
                }
                let op = webkit2gtk::PrintOperation::new(&view);
                op.set_print_settings(&settings);
                op.set_page_setup(&setup);
                let (tx_ok, tx_err) = (tx.clone(), tx.clone());
                let (w1, w2) = (win.clone(), win.clone());
                op.connect_finished(move |_| { let _ = tx_ok.send(Ok(())); let _ = w1.destroy(); });
                op.connect_failed(move |_, err| { let _ = tx_err.send(Err(err.to_string())); let _ = w2.destroy(); });
                op.print();
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
