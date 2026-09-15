import UniformTypeIdentifiers
import WebKit

/// Serves the bundled pages at crmapp://app/<path> from the app's www/ folder, and the bytes of a
/// picked file at crmapp://app/__native/file. Nothing is fetched from the network. A fixed custom
/// origin keeps IndexedDB — the database working copy — stable across launches and app updates.
///
/// The file route exists because message-handler replies can only carry text: the database used to
/// cross as base64 in 3MB chunks, which inflates it by a third, costs a full per-byte decode loop in
/// JavaScript, and holds the whole thing in memory twice over. Here WebKit takes it as binary, in
/// one streamed response, on the page's own origin so `fetch` needs no CORS.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "crmapp"
    static let origin = "crmapp://app"

    private let root: URL
    private let files: NativeFileIndex
    private let io = DispatchQueue(label: "crm.scheme.io")
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    init(root: URL, files: NativeFileIndex) {
        self.root = root.standardizedFileURL
        self.files = files
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.path == NativeBridge.filePath { return startFile(task, url: url) }
        let relative = String(url.path.drop(while: { $0 == "/" }))
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            respond(task, url: url, status: 404, type: "text/plain", body: Data("Not found".utf8))
            return
        }
        respond(task, url: url, status: 200, type: Self.mimeType(for: file), body: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    // MARK: - The file route

    private func startFile(_ task: WKURLSchemeTask, url: URL) {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String { query.first { $0.name == name }?.value ?? "" }
        let targets = files.targets(value("token"), value("path"))
        guard !targets.isEmpty else {
            return respond(task, url: url, status: 404, type: "text/plain", body: Data("Unknown file".utf8))
        }
        io.async { [self] in
            var failure: Error?
            for (root, target) in targets {
                // Once the response head is out we are committed to this candidate: a later failure
                // has to surface as a failed request, never as a silently truncated database.
                var started = false
                do {
                    try NativeBridge.stream(root: root, target: target, begin: { size in
                        started = true
                        deliver(task) { $0.didReceive(Self.head(url, size: size)) }
                    }, { part in
                        deliver(task) { $0.didReceive(part) }
                    })
                    return deliver(task, last: true) { $0.didFinish() }
                } catch {
                    failure = error
                    if started { return deliver(task, last: true) { $0.didFailWithError(error) } }
                }
            }
            deliver(task, last: true) { $0.didFailWithError(failure ?? URLError(.fileDoesNotExist)) }
        }
    }

    private static func head(_ url: URL, size: UInt64) -> URLResponse {
        HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
            // The page cache-busts on mtime+size; letting WebKit keep a copy would only mean
            // holding the database twice.
            "Cache-Control": "no-store",
        ]) ?? URLResponse(url: url, mimeType: "application/octet-stream",
                          expectedContentLength: Int(size), textEncodingName: nil)
    }

    /// WKURLSchemeTask raises an Objective-C exception — uncatchable from Swift, so a crash — if it
    /// is touched after WebKit has stopped it, and a reload part-way through a 55MB read is enough
    /// to do that. Every reply goes through here, and nothing is sent to a stopped task.
    private func deliver(_ task: WKURLSchemeTask, last: Bool = false, _ body: @escaping (WKURLSchemeTask) -> Void) {
        DispatchQueue.main.async {
            let id = ObjectIdentifier(task)
            self.lock.lock()
            let live = !self.stopped.contains(id)
            if last { self.stopped.remove(id) }
            self.lock.unlock()
            if live { body(task) }
        }
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "woff2": return "font/woff2"
        default: return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
