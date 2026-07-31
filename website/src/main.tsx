import '@fontsource-variable/spline-sans';
import '@fontsource-variable/jetbrains-mono';
import {Component, StrictMode, Suspense, lazy, type ComponentType, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';

type PageModule = {default: ComponentType};

class RouteErrorBoundary extends Component<{readonly children: ReactNode}, {readonly failed: boolean}> {
  override state = {failed: false};

  static getDerivedStateFromError(): {readonly failed: boolean} {
    return {failed: true};
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page-error" role="alert">
        <span className="eyebrow">Page unavailable</span>
        <h1>Threadnote could not load this route.</h1>
        <p>The website may have been updated while this tab was open. Reload to fetch the current assets.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    );
  }
}

const page = document.body.dataset.page ?? 'home';

const loadPage = (): Promise<PageModule> => {
  switch (page) {
    case 'docs':
      return import('./pages/DocsPage');
    case 'pro-tips':
      return import('./pages/ProTipsPage');
    case 'manager-demo':
      return import('./pages/ManagerDemoPage');
    case 'faq':
      return import('./pages/FaqPage');
    default:
      return import('./pages/LandingPage');
  }
};

const Page = lazy(loadPage);
const root = document.getElementById('root');

if (!root) {
  throw new Error('Threadnote website root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <RouteErrorBoundary>
      <Suspense
        fallback={
          <div className="page-loading" role="status">
            <span className="status-dot" />
            Loading Threadnote…
          </div>
        }
      >
        <Page />
      </Suspense>
    </RouteErrorBoundary>
  </StrictMode>,
);
