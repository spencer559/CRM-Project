import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }

    /// Leaving the app is how most edits end on a phone — locking it, taking a call, switching apps
    /// — and iOS suspends a backgrounded app within seconds. Without this, the page's own tab-hide
    /// save was started and then frozen part-way: the edits survived in the app's storage and
    /// replayed on the next launch, but the .crmdb on the stick or in OneDrive didn't have them.
    func sceneDidEnterBackground(_ scene: UIScene) {
        (window?.rootViewController as? WebViewController)?.saveInBackground()
    }
}
