# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: live-race-recovery.spec.ts >> Live Race And Recovery >> @live validates driver accept race handling and prevents duplicate production claims
- Location: ..\..\..\jago-Updates-23-04-jago\jago-Updates-23-04-jago\jago_app-main\app\tests\playwright\specs\live-race-recovery.spec.ts:19:3

# Error details

```
Error: Timed out waiting for any socket event: trip:driver_assigned, trip:accepted
```

# Test source

```ts
  1   | import { expect } from "@playwright/test";
  2   | import { io, type Socket } from "socket.io-client";
  3   | import { createQaTag, runtime } from "./runtime";
  4   | 
  5   | export function connectLiveSocket(token: string, userId: string, userType: "customer" | "driver") {
  6   |   return io(runtime.apiBaseURL, {
  7   |     transports: ["websocket", "polling"],
  8   |     path: "/socket.io",
  9   |     query: {
  10  |       userId,
  11  |       userType,
  12  |       token,
  13  |     },
  14  |     auth: {
  15  |       token,
  16  |     },
  17  |     extraHeaders: {
  18  |       Origin: runtime.baseURL,
  19  |     },
  20  |     forceNew: true,
  21  |     reconnection: true,
  22  |     reconnectionAttempts: 2,
  23  |     timeout: 20_000,
  24  |   });
  25  | }
  26  | 
  27  | export async function waitForConnect(socket: Socket, timeoutMs = 20_000) {
  28  |   await new Promise<void>((resolve, reject) => {
  29  |     const timer = setTimeout(() => reject(new Error(`socket connect timeout after ${timeoutMs}ms`)), timeoutMs);
  30  |     socket.once("connect", () => {
  31  |       clearTimeout(timer);
  32  |       resolve();
  33  |     });
  34  |     socket.once("connect_error", (error) => {
  35  |       clearTimeout(timer);
  36  |       reject(error);
  37  |     });
  38  |   });
  39  | 
  40  |   await new Promise<void>((resolve, reject) => {
  41  |     const timer = setTimeout(() => reject(new Error(`socket ready timeout after ${timeoutMs}ms`)), timeoutMs);
  42  |     socket.once("socket:ready", () => {
  43  |       clearTimeout(timer);
  44  |       resolve();
  45  |     });
  46  |     socket.once("disconnect", (reason) => {
  47  |       clearTimeout(timer);
  48  |       reject(new Error(`socket disconnected before ready: ${reason}`));
  49  |     });
  50  |   });
  51  | }
  52  | 
  53  | export async function waitForSocketEvent<T = any>(socket: Socket, eventName: string, timeoutMs = 20_000) {
  54  |   return new Promise<T>((resolve, reject) => {
  55  |     const timer = setTimeout(() => reject(new Error(`Timed out waiting for socket event ${eventName}`)), timeoutMs);
  56  |     socket.once(eventName, (payload: T) => {
  57  |       clearTimeout(timer);
  58  |       resolve(payload);
  59  |     });
  60  |   });
  61  | }
  62  | 
  63  | export async function waitForSocketEventAny<T = any>(socket: Socket, eventNames: string[], timeoutMs = 20_000) {
  64  |   return new Promise<{ eventName: string; payload: T }>((resolve, reject) => {
  65  |     const handlers = new Map<string, (payload: T) => void>();
  66  |     const cleanup = () => {
  67  |       clearTimeout(timer);
  68  |       for (const [eventName, handler] of handlers.entries()) {
  69  |         socket.off(eventName, handler);
  70  |       }
  71  |     };
  72  |     const timer = setTimeout(() => {
  73  |       cleanup();
> 74  |       reject(new Error(`Timed out waiting for any socket event: ${eventNames.join(", ")}`));
      |              ^ Error: Timed out waiting for any socket event: trip:driver_assigned, trip:accepted
  75  |     }, timeoutMs);
  76  | 
  77  |     for (const eventName of eventNames) {
  78  |       const handler = (payload: T) => {
  79  |         cleanup();
  80  |         resolve({ eventName, payload });
  81  |       };
  82  |       handlers.set(eventName, handler);
  83  |       socket.once(eventName, handler);
  84  |     }
  85  |   });
  86  | }
  87  | 
  88  | export async function expectSocketNoEvent(socket: Socket, eventName: string, durationMs = 3_000) {
  89  |   let received = false;
  90  |   const handler = () => {
  91  |     received = true;
  92  |   };
  93  |   socket.on(eventName, handler);
  94  |   await new Promise((resolve) => setTimeout(resolve, durationMs));
  95  |   socket.off(eventName, handler);
  96  |   expect(received, `Expected no ${eventName} event within ${durationMs}ms`).toBeFalsy();
  97  | }
  98  | 
  99  | export function extractTripId(body: any) {
  100 |   return body?.tripId
  101 |     || body?.id
  102 |     || body?.trip?.id
  103 |     || body?.data?.id
  104 |     || body?.booking?.id
  105 |     || body?.activeTrip?.id
  106 |     || body?.tripRequest?.id
  107 |     || null;
  108 | }
  109 | 
  110 | export function extractActiveTrip(body: any) {
  111 |   return body?.trip
  112 |     || body?.activeTrip
  113 |     || body?.data
  114 |     || body
  115 |     || null;
  116 | }
  117 | 
  118 | export function qaAddress(label: string) {
  119 |   return createQaTag(`Hyderabad QA ${label}`);
  120 | }
  121 | 
  122 | export function qaNote(label: string) {
  123 |   return createQaTag(label);
  124 | }
  125 | 
```