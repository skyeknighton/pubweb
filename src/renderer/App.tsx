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

  useEffect(() => {
    loadPages();
    loadStats();
    const interval = setInterval(loadStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadPages = async () => {
    const result = await window.chaosnet.getPages();
    setPages(result);
  };

  const loadStats = async () => {
    const result = await window.chaosnet.getStats();
    setStats(result);
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
        {activeTab === 'browse' && <PageBrowser pages={pages} />}
        {activeTab === 'upload' && <UploadForm onUpload={handleUpload} />}
        {activeTab === 'status' && <StatusDashboard stats={stats} />}
      </main>

      <footer className="app-footer">
        <p>© 2026 PubWeb — The decentralized web</p>
      </footer>
    </div>
  );
};

export default App;
