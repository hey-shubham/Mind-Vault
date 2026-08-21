const BASE = import.meta.env.VITE_API_URL || '/api';

export async function api(path: string, opts: RequestInit = {}) {
  const token = localStorage.getItem('mv_token');
  const headers: Record<string, string> = {
    ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(opts.headers as Record<string, string> || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { ...opts, headers });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!r.ok) throw new Error(data.error || data.message || `Request failed (${r.status})`);
  return data;
}

export async function uploadFiles(files: File[]) {
  const token = localStorage.getItem('mv_token');
  const form = new FormData();
  files.forEach(file => form.append('files', file));
  const r = await fetch(BASE + '/documents/upload', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Upload failed');
  return d;
}

export async function fetchFile(id: number) {
  const token = localStorage.getItem('mv_token');
  const r = await fetch(BASE + `/documents/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error('File could not be opened');
  return URL.createObjectURL(await r.blob());
}

export async function fetchSharedFile(id: number) {
  const token = localStorage.getItem('mv_token');
  const r = await fetch(BASE + `/shared/documents/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error('Shared file could not be opened');
  return URL.createObjectURL(await r.blob());
}

export async function openProtectedFile(path: string, options: { download?: boolean; filename?: string } = {}) {
  const token = localStorage.getItem('mv_token');
  const r = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(options.download ? 'File could not be downloaded' : 'File could not be opened');
  const url = URL.createObjectURL(await r.blob());
  if (options.download) {
    const link = document.createElement('a');
    link.href = url;
    link.download = options.filename || 'mindvault-file';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
