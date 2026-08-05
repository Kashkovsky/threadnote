import AppKit
import SwiftUI
import WebKit

struct ManagerWebView: NSViewRepresentable {
  let url: URL
  @Binding var loadError: String?
  @Binding var isLoading: Bool

  func makeCoordinator() -> Coordinator {
    Coordinator(
      policy: ManagerNavigationPolicy(managerURL: url),
      loadError: $loadError,
      isLoading: $isLoading
    )
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.load(URLRequest(url: url))
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.policy = ManagerNavigationPolicy(managerURL: url)
    if webView.url != url, webView.url?.host != url.host || webView.url?.port != url.port {
      webView.load(URLRequest(url: url))
    }
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var policy: ManagerNavigationPolicy
    private var loadError: Binding<String?>
    private var isLoading: Binding<Bool>

    init(
      policy: ManagerNavigationPolicy,
      loadError: Binding<String?>,
      isLoading: Binding<Bool>
    ) {
      self.policy = policy
      self.loadError = loadError
      self.isLoading = isLoading
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      loadError.wrappedValue = nil
      isLoading.wrappedValue = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      loadError.wrappedValue = "The manager page failed to load: \(error.localizedDescription)"
      isLoading.wrappedValue = false
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: Error
    ) {
      loadError.wrappedValue = "The manager could not be reached: \(error.localizedDescription)"
      isLoading.wrappedValue = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      loadError.wrappedValue =
        "The manager web process stopped unexpectedly. Close and reopen the window to retry."
      isLoading.wrappedValue = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      waitForManagerUI(webView, attemptsRemaining: 60)
    }

    private func waitForManagerUI(_ webView: WKWebView, attemptsRemaining: Int) {
      webView.evaluateJavaScript("document.getElementById('root')?.childElementCount ?? 0") {
        [weak webView] result, error in
        if let error {
          self.loadError.wrappedValue =
            "The manager page could not be inspected: \(error.localizedDescription)"
          self.isLoading.wrappedValue = false
        } else if (result as? NSNumber)?.intValue ?? 0 > 0 {
          self.loadError.wrappedValue = nil
          self.isLoading.wrappedValue = false
        } else if attemptsRemaining > 0 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak webView] in
            guard let webView else { return }
            self.waitForManagerUI(webView, attemptsRemaining: attemptsRemaining - 1)
          }
        } else {
          self.loadError.wrappedValue =
            "The manager page loaded, but its interface did not start. Restart Threadnote and try again."
          self.isLoading.wrappedValue = false
        }
      }
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      guard let url = navigationAction.request.url else {
        decisionHandler(.cancel)
        return
      }
      if policy.allows(url) {
        decisionHandler(.allow)
      } else {
        if navigationAction.navigationType == .linkActivated {
          NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
      }
    }
  }
}
