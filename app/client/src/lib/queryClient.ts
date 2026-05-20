import { QueryClient, QueryFunction } from "@tanstack/react-query";

function getAdminToken(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem("jago-admin") || "{}");
    return saved?.token || null;
  } catch {
    return null;
  }
}

function buildAdminHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (extra) {
    new Headers(extra).forEach((v, k) => { headers[k] = v; });
  }
  const token = getAdminToken();
  if (token && !headers["authorization"] && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

// Redirect to login and clear session on 401
function handle401() {
  localStorage.removeItem("jago-admin");
  if (!window.location.pathname.includes("/admin/login")) {
    window.location.href = "/admin/login";
  }
}

// Patch window.fetch at module load time so ALL raw fetch() calls in admin pages:
// 1. Get the admin Bearer token header automatically
// 2. On 401 → clear session + redirect to login (prevents crash from non-array responses)
(function patchFetch() {
  const _orig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    const isAdminApi = url.startsWith("/api/") &&
      !url.startsWith("/api/app/") &&
      !url.startsWith("/api/driver/") &&
      !url.startsWith("/api/webhook") &&
      url !== "/api/health";
    if (!isAdminApi) return _orig(input as any, init);
    const headers = buildAdminHeaders(init?.headers);
    return _orig(input as any, { ...(init || {}), headers }).then(res => {
      if (res.status === 401) {
        handle401();
        // Return a fake response so callers don't crash — they'll never use it (redirect happening)
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return res;
    });
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
