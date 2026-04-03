import React, { useState, useEffect } from 'react';
import { PageBrowser } from './components/PageBrowser';
import { StatusDashboard } from './components/StatusDashboard';

declare global {
  interface Window {
    chaosnet: any;
  }
}

export const App: React.FC = () => {
  const [pages, setPages] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [peerStatus, setPeerStatus] = useState<any>(null);
  const [retryingNatProbe, setRetryingNatProbe] = useState(false);

  useEffect(() => {
    loadPages();
    loadStats();
    loadPeerStatus();
    const statsInterval = setInterval(loadStats, 5000);
    const peerInterval = setInterval(loadPeerStatus, 5000);
    return () => {
      clearInterval(statsInterval);
      clearInterval(peerInterval);
    };
  }, []);

  const loadPages = async () => {
    const result = await window.chaosnet.getPages();
    setPages(result);
  };

  const loadStats = async () => {
    const result = await window.chaosnet.getStats();
    setStats(result);
  };

  const loadPeerStatus = async () => {
    const result = await window.chaosnet.getPeerStatus();
    setPeerStatus(result);
  };

  const handleRetryNatProbe = async () => {
    setRetryingNatProbe(true);
    try {
      const result = await window.chaosnet.retryNatProbe();
      setPeerStatus(result);
    } finally {
      setRetryingNatProbe(false);
    }
  };

  const openTracker = (path: string = '') => {
    const trackerBase = String(peerStatus?.trackerUrl || 'https://tracker.pubweb.online').replace(/\/+$/, '');
    window.open(`${trackerBase}${path}`, '_blank');
  };

  const ratio = stats
    ? (stats.bytesUploaded / Math.max(stats.bytesDownloaded || 0, 1)).toFixed(2)
    : '0.00';

  return (
    <div className="app">
      <main className="app-content">
        <div className="desktop-shell">
          <div className="desktop-shell__header">
            <div>
              <h1>PubWeb Desktop</h1>
              <p>Your local peer, stored pages, and the official network.</p>
            </div>
            <div className="desktop-shell__actions">
              <button className="shell-btn" onClick={() => openTracker('/network')}>Open Tracker</button>
              <button className="shell-btn secondary" onClick={() => openTracker('/share-image')}>Share Image</button>
            </div>
          </div>

          <div className="desktop-stats-row">
            <div className="desktop-stat">
              <span className="desktop-stat__label">Local pages</span>
              <strong>{pages.length}</strong>
            </div>
            <div className="desktop-stat">
              <span className="desktop-stat__label">Connected peers</span>
              <strong>{peerStatus?.peers ?? 0}</strong>
            </div>
            <div className="desktop-stat">
              <span className="desktop-stat__label">Port</span>
              <strong>{peerStatus?.port ?? '...'}</strong>
            </div>
            <div className="desktop-stat">
              <span className="desktop-stat__label">Ratio</span>
              <strong>{ratio}</strong>
            </div>
          </div>

          <div className="desktop-grid">
            <StatusDashboard
              stats={stats}
              peerStatus={peerStatus}
              onRetryNatProbe={handleRetryNatProbe}
              retryingNatProbe={retryingNatProbe}
            />
            <div className="desktop-side-panel">
              <div className="tracker-panel">
                <h2>Official Network</h2>
                <p>Use the public tracker to view the shared network, open the dashboard, or jump into image sharing.</p>
                <p><strong>Tracker URL:</strong> {peerStatus?.trackerUrl || 'loading...'}</p>
                <div className="tracker-panel__actions">
                  <button className="shell-btn" onClick={() => openTracker('/network')}>Network Dashboard</button>
                  <button className="shell-btn secondary" onClick={() => openTracker('')}>Tracker Home</button>
                </div>
              </div>
              <PageBrowser pages={pages} publicBaseUrl={peerStatus?.publicBaseUrl} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
