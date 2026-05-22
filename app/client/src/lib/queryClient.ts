import { QueryClient, QueryFunction } from "@tanstack/react-query";

function getSavedAdminSession(): any {
  try {
    return JSON.parse(localStorage.getItem("jago-admin") || "{}");
  } catch {
    return {};
  }
}

function getAdminToken(): string | null {
  return getSavedAdminSession()?.token || null;
}

function getAdminRefreshToken(): string | null {
  return getSavedAdminSession()?.refreshToken || null;
}

function getAdminDeviceId(): string {
  try {
    const storageKey = "jago-admin-device-id";
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = `admin-web-${crypto.randomUUID()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return "admin-web-fallback";
  }
}

function saveAdminSession(update: { token: string; refreshToken?: string | null; expiresAt?: string | null }) {
  try {
    const current = getSavedAdminSession();
    localStorage.setItem("jago-admin", JSON.stringify({
      ...current,
      token: update.token,
      refreshToken: update.refreshToken ?? current.refreshToken ?? null,
      expiresAt: update.expiresAt ?? current.expiresAt ?? null,
    }));
  } catch {
    handle401();
  }
}

function buildAdminHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (extra) {
    new Headers(extra).forEach((v, k) => { headers[k] = v; });
  }
  const token = getAdminToken();
  if (token && !headers.authorization && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (!headers["X-Device-Id"] && !headers["x-device-id"]) {
    headers["X-Device-Id"] = getAdminDeviceId();
  }
  return headers;
}

function handle401() {
  localStorage.removeItem("jago-admin");
  if (!window.location.pathname.includes("/admin/login")) {
    window.location.href = "/admin/login";
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshAdminSession(): Promise<boolean> {
  const refreshToken = getAdminRefreshToken();
  if (!refreshToken) return false;
  if (!refreshPromise) {
    refreshPromise = fetch("/api/admin/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": getAdminDeviceId(),
      },
      body: JSON.stringify({
        refreshToken,
        deviceId: getAdminDeviceId(),
      }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        if (!data?.token) return false;
        saveAdminSession({
          token: data.token,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
        });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

(function patchFetch() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const isAdminApi = url.startsWith("/api/") &&
      !url.startsWith("/api/app/") &&
      !url.startsWith("/api/driver/") &&
      !url.startsWith("/api/webhook") &&
      url !== "/api/health";
    if (!isAdminApi) return originalFetch(input as any, init);

    const makeRequest = () => originalFetch(input as any, {
      ...(init || {}),
      headers: buildAdminHeaders(init?.headers),
    });

    let response = await makeRequest();
    if (response.status === 401 && !url.startsWith("/api/admin/login") && url !== "/api/admin/auth/refresh") {
      const refreshed = await refreshAdminSession();
      if (refreshed) {
        response = await makeRequest();
      }
    }
    if (response.status === 401) {
      handle401();
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  }) as typeof window.fetch;
})();

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: buildAdminHeaders(data ? { "Content-Type": "application/json" } : {}),
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: buildAdminHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
