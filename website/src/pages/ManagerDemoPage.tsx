import {ManagerMock} from '../components/ManagerMock';
import {SiteShell} from '../components/SiteShell';
import {setDocumentMeta} from '../lib/site';

export function ManagerDemoPage(): React.ReactElement {
  setDocumentMeta(
    'Manager demo',
    'Explore Threadnote Manager with a safe interactive polyglot workspace built from mock data.',
  );

  return (
    <SiteShell page="manager-demo" fullBleed>
      <div className="manager-demo-page">
        <section className="manager-demo-hero">
          <p className="manager-demo-eyebrow">Threadnote Manager</p>
          <h1>See your engineering context, not just a list of files.</h1>
          <p>
            Explore memories, team shares, runtime health, and a polyglot code graph from one local control surface.
            This interactive preview uses synthetic data and never connects to your Threadnote home.
          </p>
          <div className="manager-demo-hero-facts" aria-label="Manager capabilities">
            <span>Local-only by default</span>
            <span>Current Git snapshot</span>
            <span>TypeScript · Kotlin · Swift · Java</span>
          </div>
        </section>

        <ManagerMock />

        <section className="manager-demo-footnote">
          <div>
            <p className="manager-demo-eyebrow">Run the real thing</p>
            <h2>Your data stays on your machine.</h2>
          </div>
          <div>
            <code>threadnote manage</code>
            <p>
              The production Manager reads the canonical <code>~/.threadnote</code> home through a loopback-only local
              server. Team sharing remains explicit.
            </p>
          </div>
        </section>
      </div>
    </SiteShell>
  );
}

export default ManagerDemoPage;
