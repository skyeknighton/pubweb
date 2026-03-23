import React, { useState, useEffect } from 'react';

declare global {
  interface Window {
    chaosnet: any;
  }
}

export const StatusDashboard: React.FC<{ stats: any }> = ({ stats }) => {
  const [peerStatus, setPeerStatus] = useState<any>(null);

  useEffect(() => {
    const loadPeerStatus = async () => {
      const status = await window.chaosnet.getPeerStatus();
      setPeerStatus(status);
    };

    loadPeerStatus();
    const interval = setInterval(loadPeerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="status-dashboard">
      <h2>Network Status & Statistics</h2>

      <div className="status-grid">
        <div className="status-card">
          <h3>Peer Info</h3>
          {peerStatus ? (
            <>
              <p>
                <strong>Status:</strong> <span className={peerStatus.isOnline ? 'online' : 'offline'}>
                  {peerStatus.isOnline ? '🟢 Online' : '🔴 Offline'}
                </span>
              </p>
              <p>
                <strong>Port:</strong> {peerStatus.port}
              </p>
              <p>
                <strong>Connected Peers:</strong> {peerStatus.peers}
              </p>
              <p>
                <strong>Pages Hosting:</strong> {peerStatus.pageCount}
              </p>
            </>
          ) : (
            <p>Loading...</p>
          )}
        </div>

        <div className="status-card">
          <h3>Your Stats Today</h3>
          {stats ? (
            <>
              <p>
                <strong>Uploaded:</strong> {formatBytes(stats.bytesUploaded)}
              </p>
              <p>
                <strong>Downloaded:</strong> {formatBytes(stats.bytesDownloaded)}
              </p>
              <p>
                <strong>Ratio:</strong>{' '}
                {(stats.bytesUploaded / Math.max(stats.bytesDownloaded, 1)).toFixed(2)}
              </p>
              <p>
                <strong>Pages:</strong> {stats.pagesHosted}
              </p>
            </>
          ) : (
            <p>Loading...</p>
          )}
        </div>

        <div className="status-card">
          <h3>Network Info</h3>
          <p>Connecting to central tracker...</p>
          <p>Check back soon for leaderboard position</p>
        </div>
      </div>
    </div>
  );
};
