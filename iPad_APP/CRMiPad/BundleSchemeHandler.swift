import UniformTypeIdentifiers
import WebKit

/// Serves the bundled pages at crmapp://app/<path> from the app's www/ folder. Nothing is fetched
/// from the network. A fixed custom origin keeps IndexedDB — the database working copy — stable
/// across launches and app updates.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "crmapp"
    static let origin = "crmapp://app"

    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let relative = String(url.path.drop(while: { $0 == "/" }))
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            respond(task, url: url, status: 404, type: "text/plain", body: Data("Not found".utf8))
            return
        }
        respond(task, url: url, status: 200, type: Self.mimeType(for: file), body: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

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
