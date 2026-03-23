import React from 'react';

export const PageBrowser: React.FC<{ pages: any[] }> = ({ pages }) => {
  return (
    <div className="page-browser">
      <h2>Browse Pages</h2>

      {pages.length === 0 ? (
        <p className="empty">No pages yet. Upload one to get started!</p>
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
                  window.open(`http://localhost:3000/page/${page.hash}`, '_blank');
                }}
              >
                View Page
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
