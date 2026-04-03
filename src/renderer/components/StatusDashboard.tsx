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
    <section className="status-dashboard compact-panel">
      <div className="panel-header">
        <div>
          <h2>Local Peer</h2>
          <p>Your desktop node and network reachability.</p>
        </div>
        <span className={`connectivity-badge ${connectivity.className}`}>{connectivity.label}</span>
      </div>

      {peerStatus ? (
        <>
          <div className="status-list">
            <div className="status-row"><span>Status</span><strong className={peerStatus.isOnline ? 'online' : 'offline'}>{peerStatus.isOnline ? 'Online' : 'Offline'}</strong></div>
            <div className="status-row"><span>Port</span><strong>{peerStatus.port}</strong></div>
            <div className="status-row"><span>Tracker</span><strong>{peerStatus.trackerUrl || 'n/a'}</strong></div>
            <div className="status-row"><span>NAT type</span><strong>{peerStatus.natType || 'unknown'}</strong></div>
            <div className="status-row"><span>Last probe</span><strong>{formatProbeTime(peerStatus.lastProbeAt)}</strong></div>
            <div className="status-row"><span>Uploaded</span><strong>{stats ? formatBytes(stats.bytesUploaded) : '...'}</strong></div>
            <div className="status-row"><span>Downloaded</span><strong>{stats ? formatBytes(stats.bytesDownloaded) : '...'}</strong></div>
          </div>

          {peerStatus.publicBaseUrl && (
            <div className="status-url-box">
              <span>Public URL</span>
              <strong>{peerStatus.publicBaseUrl}</strong>
            </div>
          )}

          {peerStatus.lastProbeError && (
            <p className="status-warning">{peerStatus.lastProbeError}</p>
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
        <p>Loading local peer status...</p>
      )}
    </section>
  );
};
