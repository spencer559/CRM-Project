import UIKit
@preconcurrency import WebKit

/// Hosts the offline pages. Wires up what WKWebView doesn't provide on its own: the bundled-page
/// scheme, the native file/print shim, window.open popups (the PDF Viewer reads its document from
/// window.opener, so each popup must be a real child web view), alert/confirm/prompt, and downloads.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private static let startURL = URL(string: BundleSchemeHandler.origin + "/protected/Patient_Schedule.html")!

    private let bridge = NativeBridge()
    private var webView: WKWebView!
    private var popups: [ObjectIdentifier: UINavigationController] = [:]
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var backgroundSaveTimeout: Timer?

    override var prefersStatusBarHidden: Bool { true }

    override func loadView() {
        let config = WKWebViewConfiguration()
        let www = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
        config.setURLSchemeHandler(BundleSchemeHandler(root: www, files: bridge.files), forURLScheme: BundleSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Pinch zoom stays available after crm-native-shim.js caps the viewport at maximum-scale=1,
        // which it does so an iPhone stops zooming the page into every small field that gets focus.
        config.ignoresViewportScaleLimits = true
        if let shim = Bundle.main.url(forResource: "crm-native-shim", withExtension: "js"),
           let source = try? String(contentsOf: shim, encoding: .utf8) {
            config.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)
        webView = makeWebView(configuration: config)
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge.host = self
        webView.load(URLRequest(url: Self.startURL))
    }

    private func makeWebView(configuration: WKWebViewConfiguration) -> WKWebView {
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsLinkPreview = false
        if #available(iOS 16.4, *) { web.isInspectable = true }   // debuggable from Safari ▸ Develop on a Mac
        return web
    }

    // MARK: - Saving on the way out

    /// Ask iOS for time, let the page finish the save its own tab-hide handler started, and give the
    /// time back the moment it reports done. The page does the deciding (`flushForBackground` in
    /// crm-native-shim.js): this only keeps the app — and with it the web content process — alive
    /// long enough for the write to land in the `.crmdb`.
    ///
    /// Belt and braces around a background assertion, because iOS ends the app if one is left open:
    /// the expiration handler releases it, a timer releases it if the page never answers, and
    /// `release` runs once however it arrives.
    func saveInBackground() {
        var task = UIBackgroundTaskIdentifier.invalid
        var released = false
        let release: () -> Void = { [weak self] in
            guard !released else { return }
            released = true
            self?.backgroundSaveTimeout?.invalidate()
            self?.backgroundSaveTimeout = nil
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "crm.save") { release() }
        guard task != .invalid else { return }   // iOS refused; nothing to hold the app open with

        // The page's own work is bounded (a report rebuild gives up after 6s), so this is only for
        // a page that never replies at all — a crashed content process, say.
        backgroundSaveTimeout = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in
            NSLog("CRM background save: gave up waiting for the page")
            release()
        }
        webView.callAsyncJavaScript("return await window.CRMNative.flushForBackground()",
                                    in: nil, in: .page) { result in
            switch result {
            case .success(let value): NSLog("CRM background save: %@", (value as? String) ?? "done")
            case .failure(let error): NSLog("CRM background save failed: %@", "\(error)")
            }
            release()
        }
    }

    // MARK: - Popups (window.open / target=_blank)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let child = makeWebView(configuration: configuration)
        let page = UIViewController()
        page.view = child
        page.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self, weak child] _ in
            if let child { self?.closePopup(child) }
        })
        let nav = UINavigationController(rootViewController: page)
        nav.modalPresentationStyle = .fullScreen
        popups[ObjectIdentifier(child)] = nav
        bridge.topViewController()?.present(nav, animated: true)
        return child
    }

    func webViewDidClose(_ webView: WKWebView) {
        closePopup(webView)
    }

    private func closePopup(_ web: WKWebView) {
        guard let nav = popups.removeValue(forKey: ObjectIdentifier(web)) else { return }
        nav.presentingViewController?.dismiss(animated: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        popups[ObjectIdentifier(webView)]?.topViewController?.title = webView.title
        #if DEBUG
        // Startup self-check (no patient data): the database's password encryption needs a secure
        // context and crypto.subtle, autosave needs the shim. Read it on a Mac with
        //   xcrun simctl spawn booted log show --last 5m --predicate 'process == "CRMiPad"'
        let probe = "JSON.stringify({page: location.pathname, secureContext: isSecureContext, "
            + "subtle: !!(window.crypto && crypto.subtle), indexedDB: !!window.indexedDB, "
            + "nativeShim: !!window.CRMNative, autosave: !!(window.CRMWorkspace && CRMWorkspace.canAutosave)})"
        webView.evaluateJavaScript(probe) { result, error in
            NSLog("CRM probe: %@", (result as? String) ?? error.map { "\($0)" } ?? "nil")
        }
        #endif
    }

    // A crashed content process (e.g. memory pressure from a huge PDF) would leave a blank page; the
    // working copy lives in IndexedDB, so reloading picks up where it left off.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - alert / confirm / prompt

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if !show(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if !show(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        if !show(alert) { completionHandler(nil) }
    }

    /// WebKit requires every dialog's completion handler to run, so report when nothing was shown.
    private func show(_ alert: UIAlertController) -> Bool {
        guard let top = bridge.topViewController(), top.viewIfLoaded?.window != nil else { return false }
        top.present(alert, animated: true)
        return true
    }

    // MARK: - Navigation (offline only) and downloads

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        switch navigationAction.request.url?.scheme?.lowercased() {
        case BundleSchemeHandler.scheme, "blob", "about", "data": decisionHandler(.allow)
        default: decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(suggestedFilename)
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    /// A finished download is handed to the Files sheet so the user chooses where it goes.
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        bridge.topViewController()?.present(UIDocumentPickerViewController(forExporting: [file], asCopy: true), animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads[ObjectIdentifier(download)] = nil
    }
}
