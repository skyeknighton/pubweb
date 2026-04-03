import React, { useState } from 'react';

declare global {
  interface Window {
    chaosnet: any;
  }
}

interface StatusDashboardProps {
  stats: any;
  peerStatus: any;
  retryingNatProbe: boolean;
  onRetryNatProbe: () => Promise<void>;
}

export const StatusDashboard: React.FC<StatusDashboardProps> = ({
  stats,
  peerStatus,
  retryingNatProbe,
  onRetryNatProbe,
}) => {
  const [copyMessage, setCopyMessage] = useState('');

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const getConnectivityBadge = () => {
    if (!peerStatus?.isOnline) {
      return { label: 'Offline', className: 'connectivity-offline' };
    }
    if (peerStatus?.reachable && peerStatus?.publicBaseUrl) {
      return { label: 'Direct Reachable', className: 'connectivity-direct' };
    }
    if (peerStatus?.relayRequired) {
      return { label: 'Relay Required', className: 'connectivity-relay' };
    }
    return { label: 'Local Only', className: 'connectivity-local' };
  };

  const formatProbeTime = (timestamp: number | null | undefined) => {
    if (!timestamp) {
      return 'Never';
    }
    return new Date(timestamp).toLocaleTimeString();
  };

  const handleCopyPublicUrl = async () => {
    const url = peerStatus?.publicBaseUrl;
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopyMessage('Copied public URL');
      setTimeout(() => setCopyMessage(''), 1500);
    } catch {
      setCopyMessage('Copy failed');
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const connectivity = getConnectivityBadge();

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
              <p>
                <strong>Connectivity:</strong>{' '}
                <span className={`connectivity-badge ${connectivity.className}`}>{connectivity.label}</span>
              </p>
              <p>
                <strong>NAT Type:</strong> {peerStatus.natType || 'unknown'}
              </p>
              <p>
                <strong>Probe Status:</strong> {peerStatus.probeStatus || 'pending'}
              </p>
              <p>
                <strong>Last Probe:</strong> {formatProbeTime(peerStatus.lastProbeAt)}
              </p>
              {peerStatus.publicBaseUrl && (
                <p>
                  <strong>Public URL:</strong> {peerStatus.publicBaseUrl}
                </p>
              )}
              {peerStatus.lastProbeError && (
                <p className="status-warning">
                  <strong>Probe Note:</strong> {peerStatus.lastProbeError}
                </p>
              )}
              <div className="status-actions">
                <button
                  className="status-btn"
                  onClick={onRetryNatProbe}
                  disabled={retryingNatProbe}
                >
                  {retryingNatProbe ? 'Retrying NAT Probe...' : 'Retry NAT Probe'}
                </button>
                <button
                  className="status-btn secondary"
                  onClick={handleCopyPublicUrl}
                  disabled={!peerStatus.publicBaseUrl}
                >
                  Copy Public URL
                </button>
              </div>
              {copyMessage && <p className="status-note">{copyMessage}</p>}
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
