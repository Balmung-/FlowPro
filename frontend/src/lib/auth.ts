const TOKEN_KEY = "flowpro_token";

function readCookieToken(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const prefix = `${TOKEN_KEY}=`;
  const cookie = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : null;
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const cookieToken = readCookieToken();
  if (!cookieToken) {
    window.localStorage.removeItem(TOKEN_KEY);
    return null;
  }
  if (window.localStorage.getItem(TOKEN_KEY) !== cookieToken) {
    window.localStorage.setItem(TOKEN_KEY, cookieToken);
  }
  return cookieToken;
}

export function setAuthSession(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  document.cookie = `${TOKEN_KEY}=${token}; Path=/; Max-Age=604800; SameSite=Lax`;
}

export function clearAuthSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}
