import React, { useState, useEffect } from 'react';
import { UploadForm } from './components/UploadForm';
import { PageBrowser } from './components/PageBrowser';
import { StatusDashboard } from './components/StatusDashboard';

declare global {
  interface Window {
    chaosnet: any;
  }
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'upload' | 'browse' | 'status'>('browse');
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

  const handleUpload = async (data: any) => {
    await window.chaosnet.uploadPage(data);
    loadPages();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>PubWeb</h1>
        <p>Decentralized Webpage Hosting</p>
      </header>

      <nav className="app-nav">
        <button
          className={activeTab === 'browse' ? 'active' : ''}
          onClick={() => setActiveTab('browse')}
        >
          Browse Pages
        </button>
        <button
          className={activeTab === 'upload' ? 'active' : ''}
          onClick={() => setActiveTab('upload')}
        >
          Upload Page
        </button>
        <button
          className={activeTab === 'status' ? 'active' : ''}
          onClick={() => setActiveTab('status')}
        >
          Status & Stats
        </button>
      </nav>

      <main className="app-content">
        {activeTab === 'browse' && <PageBrowser pages={pages} publicBaseUrl={peerStatus?.publicBaseUrl} />}
        {activeTab === 'upload' && <UploadForm onUpload={handleUpload} />}
        {activeTab === 'status' && (
          <StatusDashboard
            stats={stats}
            peerStatus={peerStatus}
            onRetryNatProbe={handleRetryNatProbe}
            retryingNatProbe={retryingNatProbe}
          />
        )}
      </main>

      <footer className="app-footer">
        <p>© 2026 PubWeb — The decentralized web</p>
      </footer>
    </div>
  );
};

export default App;
