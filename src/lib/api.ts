export const apiFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('jays_notes_token');
  
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });
  
  if (res.status === 401 || res.status === 403) {
    // Only redirect to login if it's an API route and we got unauthorized
    if (url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
      localStorage.removeItem('jays_notes_token');
      window.dispatchEvent(new Event('auth-expired'));
    }
  }
  
  return res;
};
