import UIKit
import UniformTypeIdentifiers
@preconcurrency import WebKit

/// Native half of crm-native-shim.js. Backs the File System Access subset the pages use with iOS
/// document pickers, security-scoped bookmarks and coordinated reads/writes, so a .crmdb picked
/// from On My iPad, iCloud Drive or a USB stick is autosaved in place, and a picked folder can be
/// filled with real subfolders and files (Download patients). Also drives printing.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    static let name = "crmNative"

    /// Pickers and alerts are presented over this controller's top-most presented child.
    weak var host: UIViewController?

    private struct Failure: Error {
        let name: String
        let message: String
    }

    private final class WriteSession {
        let token: String
        let path: String
        var data = Data()
        init(token: String, path: String) { self.token = token; self.path = path }
    }

    private typealias Finish = (Result<[String: Any], Error>) -> Void

    private let io = DispatchQueue(label: "crm.native.io")
    private let bookmarksKey = "crmNative.bookmarks"
    private lazy var bookmarks: [String: Data] =
        (UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data]) ?? [:]
    private var writes: [String: WriteSession] = [:]
    private var pendingPick: (([URL]) -> Void)?

    // MARK: - Messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let body = message.body as? [String: Any] ?? [:]
        let finish: Finish = { result in
            switch result {
            case .success(let value): replyHandler(value, nil)
            case .failure(let error): replyHandler(Self.describe(error), nil)
            }
        }
        switch body["op"] as? String {
        case "pickOpen":
            pickOpen(multiple: body["multiple"] as? Bool ?? false, finish)
        case "pickSave":
            pickSave(name: body["suggestedName"] as? String ?? "Untitled", finish)
        case "pickFolder":
            pickFolder(finish)
        case "dirEntry":
            let name = body["name"] as? String ?? ""
            let directory = (body["kind"] as? String) == "directory"
            let create = body["create"] as? Bool ?? false
            withFile(body["token"], body["path"], finish) { dir in
                try Self.entry(in: dir, name: name, directory: directory, create: create)
            }
        case "stat":
            withFile(body["token"], body["path"], finish) { url in try Self.stat(url) }
        case "read":
            let offset = (body["offset"] as? NSNumber)?.uint64Value ?? 0
            let length = (body["length"] as? NSNumber)?.intValue ?? 0
            withFile(body["token"], body["path"], finish) { url in ["data": try Self.read(url, offset: offset, length: length)] }
        case "permission":
            permission(body["token"], finish)
        case "writeBegin":
            guard let token = body["token"] as? String, (try? resolve(token)) != nil else {
                return finish(.failure(Failure(name: "NotFoundError", message: "This file is no longer linked. Open it again.")))
            }
            let session = UUID().uuidString
            writes[session] = WriteSession(token: token, path: body["path"] as? String ?? "")
            finish(.success(["session": session]))
        case "writeChunk":
            guard let session = writes[body["session"] as? String ?? ""],
                  let chunk = Data(base64Encoded: body["data"] as? String ?? "") else {
                return finish(.failure(Failure(name: "InvalidStateError", message: "Save interrupted. Try again.")))
            }
            session.data.append(chunk)
            finish(.success([:]))
        case "writeCommit":
            guard let session = writes.removeValue(forKey: body["session"] as? String ?? "") else {
                return finish(.failure(Failure(name: "InvalidStateError", message: "Save interrupted. Try again.")))
            }
            let data = session.data
            withFile(session.token, session.path, finish) { url in try Self.write(data, to: url) }
        case "writeAbort":
            writes[body["session"] as? String ?? ""] = nil
            finish(.success([:]))
        case "printPdf":
            guard let data = Data(base64Encoded: body["data"] as? String ?? "") else {
                return finish(.failure(Failure(name: "DataError", message: "Nothing to print.")))
            }
            let printer = UIPrintInteractionController.shared
            printer.printFormatter = nil
            printer.printInfo = Self.printInfo(named: "PDF")
            printer.printingItem = data
            present(printer, finish)
        case "printPage":
            guard let web = message.webView else {
                return finish(.failure(Failure(name: "InvalidStateError", message: "Nothing to print.")))
            }
            let printer = UIPrintInteractionController.shared
            printer.printingItem = nil
            printer.printInfo = Self.printInfo(named: web.title ?? "CRM")
            printer.printFormatter = web.viewPrintFormatter()
            present(printer, finish)
        default:
            finish(.failure(Failure(name: "NotSupportedError", message: "Unsupported operation.")))
        }
    }

    // MARK: - Pickers

    private func pickOpen(multiple: Bool, _ finish: @escaping Finish) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
        picker.allowsMultipleSelection = multiple
        present(picker, finish) { [unowned self] urls in
            finish(Result { ["files": try urls.map { try self.register($0) }] })
        }
    }

    /// Like Chrome's save picker: the user chooses a folder and name, and the file is created there.
    /// An empty placeholder is exported (moved, not copied) to the chosen spot and bookmarked.
    private func pickSave(name: String, _ finish: @escaping Finish) {
        let cleaned = name.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let placeholder = folder.appendingPathComponent(cleaned.isEmpty ? "Untitled" : cleaned)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data().write(to: placeholder)
        } catch {
            return finish(.failure(error))
        }
        let picker = UIDocumentPickerViewController(forExporting: [placeholder], asCopy: false)
        present(picker, finish) { [unowned self] urls in
            finish(Result { try self.register(urls[0]) })
        }
    }

    /// Like Chrome's directory picker: the chosen folder is bookmarked, and everything written under
    /// it later is reached through that one bookmark plus a relative path.
    private func pickFolder(_ finish: @escaping Finish) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        present(picker, finish) { [unowned self] urls in
            finish(Result { try self.register(urls[0]) })
        }
    }

    private func present(_ picker: UIDocumentPickerViewController, _ finish: @escaping Finish,
                         onPick: @escaping ([URL]) -> Void) {
        guard pendingPick == nil else {
            return finish(.failure(Failure(name: "InvalidStateError", message: "A file picker is already open.")))
        }
        guard let top = topViewController() else {
            return finish(.failure(Failure(name: "InvalidStateError", message: "The app isn't ready to show a file picker.")))
        }
        picker.delegate = self
        pendingPick = { urls in
            if urls.isEmpty {
                finish(.failure(Failure(name: "AbortError", message: "The user aborted a request.")))
            } else {
                onPick(urls)
            }
        }
        top.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        completePick(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        completePick([])
    }

    private func completePick(_ urls: [URL]) {
        let done = pendingPick
        pendingPick = nil
        done?(urls)
    }

    func topViewController() -> UIViewController? {
        var top = host
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    // MARK: - Bookmarks

    private func register(_ url: URL) throws -> [String: Any] {
        let data = try Self.withAccess(url) { try Self.bookmark(url) }
        let token = UUID().uuidString
        bookmarks[token] = data
        UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
        return ["token": token, "name": url.lastPathComponent]
    }

    private func resolve(_ token: Any?) throws -> URL {
        guard let token = token as? String else {
            throw Failure(name: "NotFoundError", message: "This file is no longer linked. Open it again.")
        }
        // Another app window (each has its own bridge) may have registered this file since we loaded.
        if bookmarks[token] == nil, let saved = UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data] {
            bookmarks.merge(saved) { current, _ in current }
        }
        guard let data = bookmarks[token] else {
            throw Failure(name: "NotFoundError", message: "This file is no longer linked. Open it again.")
        }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            throw Failure(name: "NotFoundError", message: "Can't reach the database file. If it's on a USB stick, plug it in and try again.")
        }
        if stale, let fresh = try? Self.withAccess(url, { try Self.bookmark(url) }) {
            bookmarks[token] = fresh
            UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
        }
        return url
    }

    /// Resolves the handle — the picked item, or `path` inside a picked folder — and runs `work` on
    /// it off the main thread, inside the picked item's security scope. Replies on the main thread.
    private func withFile(_ token: Any?, _ path: Any?, _ finish: @escaping Finish,
                          _ work: @escaping @Sendable (URL) throws -> [String: Any]) {
        let root: URL, target: URL
        do {
            root = try resolve(token)
            target = try Self.descend(root, path as? String ?? "")
        } catch {
            return finish(.failure(error))
        }
        io.async {
            let result = Result { try Self.withAccess(root) { try work(target) } }
            DispatchQueue.main.async { finish(result) }
        }
    }

    private func permission(_ token: Any?, _ finish: @escaping Finish) {
        guard let url = try? resolve(token) else { return finish(.success(["state": "prompt"])) }
        io.async {
            let reachable = (try? Self.withAccess(url) { try Self.isReadable(url) }) ?? false
            DispatchQueue.main.async { finish(.success(["state": reachable ? "granted" : "prompt"])) }
        }
    }

    // MARK: - File I/O (runs on the io queue)

    nonisolated private static func bookmark(_ url: URL) throws -> Data {
        try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    nonisolated private static func withAccess<T>(_ url: URL, _ body: () throws -> T) rethrows -> T {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try body()
    }

    nonisolated private static func coordinateRead(_ url: URL, _ body: (URL) throws -> Void) throws {
        var coordinationError: NSError?
        var bodyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { url in
            do { try body(url) } catch { bodyError = error }
        }
        if let error = coordinationError { throw error }
        if let error = bodyError { throw error }
    }

    /// A coordinated read, so a file that's only in iCloud is fetched rather than reported missing.
    nonisolated private static func isReadable(_ url: URL) throws -> Bool {
        var readable = false
        try coordinateRead(url) { readable = FileManager.default.isReadableFile(atPath: $0.path) }
        return readable
    }

    /// A path inside a picked folder, built one checked component at a time, so nothing a page sends
    /// can reach outside the folder the user chose.
    nonisolated private static func descend(_ root: URL, _ path: String) throws -> URL {
        guard !path.isEmpty else { return root }
        var url = root
        for part in path.split(separator: "/", omittingEmptySubsequences: false) {
            url.appendPathComponent(try validName(String(part)))
        }
        return url
    }

    nonisolated private static func validName(_ name: String) throws -> String {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\") else {
            throw Failure(name: "TypeError", message: "Name is not allowed.")
        }
        return name
    }

    /// getDirectoryHandle / getFileHandle: the entry has to exist as that kind, or be created.
    nonisolated private static func entry(in dir: URL, name: String, directory: Bool, create: Bool) throws -> [String: Any] {
        let url = dir.appendingPathComponent(try validName(name), isDirectory: directory)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue == directory else {
                throw Failure(name: "TypeMismatchError", message: "\(name) is \(directory ? "a file" : "a folder") here.")
            }
        } else if !create {
            throw Failure(name: "NotFoundError", message: "\(name) was not found.")
        } else if directory {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        } else {
            try Data().write(to: url)
        }
        return ["name": name]
    }

    nonisolated private static func stat(_ url: URL) throws -> [String: Any] {
        var info: [String: Any] = [:]
        try coordinateRead(url) { url in
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let modified = attributes[.modificationDate] as? Date ?? Date()
            info = [
                "name": url.lastPathComponent,
                "size": (attributes[.size] as? NSNumber)?.int64Value ?? 0,
                "lastModified": (modified.timeIntervalSince1970 * 1000).rounded(),
            ]
        }
        return info
    }

    nonisolated private static func read(_ url: URL, offset: UInt64, length: Int) throws -> String {
        var chunk = Data()
        try coordinateRead(url) { url in
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: offset)
            chunk = try handle.read(upToCount: length) ?? Data()
        }
        return chunk.base64EncodedString()
    }

    nonisolated private static func write(_ data: Data, to url: URL) throws -> [String: Any] {
        var coordinationError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { url in
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                // An atomic save creates a sibling temp file, which a single picked file's scope
                // doesn't always allow (some USB / file-provider locations) — write in place instead.
                do { try data.write(to: url) } catch { writeError = error }
            }
        }
        if let error = coordinationError { throw error }
        if let error = writeError { throw error }
        return try stat(url)
    }

    nonisolated private static func describe(_ error: Error) -> [String: Any] {
        if let failure = error as? Failure { return ["error": failure.message, "name": failure.name] }
        let ns = error as NSError
        guard ns.domain == NSCocoaErrorDomain else { return ["error": ns.localizedDescription, "name": "NotReadableError"] }
        switch ns.code {
        case NSFileNoSuchFileError, NSFileReadNoSuchFileError:
            return ["error": "Can't reach the database file. If it's on a USB stick, plug it in and try again.", "name": "NotFoundError"]
        case NSFileWriteVolumeReadOnlyError:
            return ["error": "This drive is read-only. iPad can't write to NTFS — reformat the stick as exFAT.", "name": "NotAllowedError"]
        case NSFileReadNoPermissionError, NSFileWriteNoPermissionError:
            return ["error": ns.localizedDescription, "name": "NotAllowedError"]
        default:
            return ["error": ns.localizedDescription, "name": "NotReadableError"]
        }
    }

    // MARK: - Printing

    private static func printInfo(named name: String) -> UIPrintInfo {
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = name
        return info
    }

    private func present(_ printer: UIPrintInteractionController, _ finish: @escaping Finish) {
        let shown = printer.present(animated: true) { _, completed, error in
            if let error { finish(.failure(error)) } else { finish(.success(["completed": completed])) }
        }
        if !shown { finish(.failure(Failure(name: "InvalidStateError", message: "Could not open the print dialog."))) }
    }
}
