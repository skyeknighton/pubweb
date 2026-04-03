import React from 'react';

export const PageBrowser: React.FC<{ pages: any[]; publicBaseUrl?: string }> = ({ pages, publicBaseUrl }) => {
  const baseUrl = (publicBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');

  return (
    <section className="page-browser compact-panel">
      <div className="panel-header">
        <div>
          <h2>Stored Pages</h2>
          <p>Pages currently available from this desktop client.</p>
        </div>
      </div>

      {pages.length === 0 ? (
        <p className="empty">No local pages stored yet.</p>
      ) : (
        <div className="page-list">
          {pages.map((page) => (
            <div key={page.id} className="page-card">
              <h3>{page.title}</h3>
              <p className="meta">
                by <strong>{page.author}</strong> • {new Date(page.created).toLocaleDateString()}
              </p>
              {page.tags && page.tags.length > 0 && (
                <div className="tags">
                  {page.tags.map((tag: string, i: number) => (
                    <span key={i} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <p className="size">Size: {(page.size / 1024).toFixed(2)} KB</p>
              <button
                className="view-btn"
                onClick={() => {
                  window.open(`${baseUrl}/page/${page.hash}`, '_blank');
                }}
              >
                Open Page
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
