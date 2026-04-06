import React from 'react';

export const PageBrowser: React.FC<{ pages: any[]; publicBaseUrl?: string }> = ({ pages, publicBaseUrl }) => {
  const baseUrl = (publicBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');

  const formatPageSize = (page: any) => {
    const explicitSize = typeof page?.size === 'number' && Number.isFinite(page.size)
      ? page.size
      : null;
    const htmlSize = typeof page?.html === 'string'
      ? new TextEncoder().encode(page.html).length
      : null;
    const bytes = explicitSize ?? htmlSize;

    if (bytes === null) {
      return 'Unknown size';
    }

    return `Size: ${(bytes / 1024).toFixed(2)} KB`;
  };

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
              <p className="size">{formatPageSize(page)}</p>
              <button
                className="view-btn"
                onClick={() => {
                  void window.chaosnet.openExternal(`${baseUrl}/page/${page.hash}`);
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
