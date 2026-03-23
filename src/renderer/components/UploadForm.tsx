import React from 'react';

export const UploadForm: React.FC<{ onUpload: (data: any) => void }> = ({ onUpload }) => {
  const [title, setTitle] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [html, setHtml] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);

  const handleExampleHTML = () => {
    setHtml(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; }
    .content { background: white; padding: 20px; border-radius: 8px; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>My First Chaosnet Page</h1>
  <div class="content">
    <p>Edit this HTML to create your page!</p>
    <p>Remember: keep it under 1MB, include all assets inline.</p>
  </div>
</body>
</html>`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await onUpload({
        title: title || 'Untitled Page',
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        html,
      });

      setTitle('');
      setTags('');
      setHtml('');
      alert('Page uploaded successfully!');
    } catch (error) {
      alert('Upload failed: ' + error);
    } finally {
      setIsLoading(false);
    }
  };

  const htmlSize = Buffer.byteLength(html);
  const sizePercent = (htmlSize / (1024 * 1024)) * 100;
  const sizeStatus = sizePercent > 100 ? 'error' : sizePercent > 80 ? 'warning' : 'ok';

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <h2>Create a New Page</h2>

      <div className="form-group">
        <label htmlFor="title">Page Title</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
          placeholder="My Trip to New York"
        />
      </div>

      <div className="form-group">
        <label htmlFor="tags">Tags (comma-separated)</label>
        <input
          id="tags"
          type="text"
          value={tags}
          onChange={(e) => setTags((e.target as HTMLInputElement).value)}
          placeholder="travel, nyc, 2026"
        />
      </div>

      <div className="form-group">
        <label htmlFor="html">HTML Content</label>
        <textarea
          id="html"
          value={html}
          onChange={(e) => setHtml((e.target as HTMLTextAreaElement).value)}
          placeholder="<html><body><h1>Your page here</h1></body></html>"
          rows={15}
          required
        />
        <small>
          Size: {(htmlSize / 1024).toFixed(2)} KB / 1024 KB
          <span className={`status-${sizeStatus}`}>
            {sizeStatus === 'ok' ? ' ✓' : sizeStatus === 'warning' ? ' ⚠' : ' ✗'}
          </span>
        </small>
        <button type="button" onClick={handleExampleHTML} style={{ marginTop: '0.5rem' }}>
          Load Example
        </button>
      </div>

      <button type="submit" disabled={isLoading || htmlSize > 1024 * 1024}>
        {isLoading ? 'Uploading...' : 'Upload Page'}
      </button>
    </form>
  );
};
