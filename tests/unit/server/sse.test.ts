import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../../../src/server";
import { world } from "../../sim/harness";

/** Capture the production handler without binding a socket; only the fixture's real file watcher runs. */
async function fixture() {
  const w = await world();
  await mkdir(w.dirs.records, { recursive: true });
  let handler: (req: Request) => Promise<Response> = async () => {
    throw new Error("handler missing");
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const serve = spyOn(Bun, "serve").mockImplementation((options) => {
    handler = options.fetch as typeof handler;
    return { port: 4848, stop() {} } as ReturnType<typeof Bun.serve>;
  });
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    const id = ++nextTimer;
    timers.set(id, callback as () => void);
    return id;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
    timers.delete(id as unknown as number);
  });
  const server = await startServer({ port: 0, dirs: w.dirs, cfg: w.cfg, clock: w.clock, linearClient: null });
  const request = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    handler(
      new Request(`${server.url}${path}`, { ...init, headers: { host: "127.0.0.1:4848", ...headers } }),
    );
  const bootstrap = async () => {
    const page = await request("/");
    return {
      cookie: page.headers.get("set-cookie")?.split(";")[0] ?? "",
      "x-wingmate-csrf": (await page.text()).match(/name="wingmate-csrf" content="([^"]+)"/)?.[1] ?? "",
    };
  };
  const open = async (session: Awaited<ReturnType<typeof bootstrap>>, signal?: AbortSignal) => {
    const response = await request(
      "/api/events",
      { ...session, "sec-fetch-site": "same-origin" },
      signal ? { signal } : {},
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no stream");
    return reader;
  };
  const broadcast = async () => {
    const session = await bootstrap();
    const response = await request(
      "/api/actions/pause",
      {
        ...session,
        origin: server.url,
        "content-type": "application/json",
      },
      { method: "POST", body: JSON.stringify({ scope: "global", on: true }) },
    );
    expect(response.status).toBe(200);
  };
  const cleanup = () => {
    server.stop();
    serve.mockRestore();
    interval.mockRestore();
    clear.mockRestore();
  };
  return { w, server, timers, clear, bootstrap, open, broadcast, cleanup };
}

async function boundedRead(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SSE did not close")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("SSE authorization at every delivery and idempotent disposal", () => {
  for (const cause of ["expired", "evicted"] as const) {
    for (const source of ["action", "file-watch", "timer"] as const) {
      test(`${cause} session receives no ${source} event before the next heartbeat`, async () => {
        const f = await fixture();
        try {
          const session = await f.bootstrap();
          const reader = await f.open(session);
          expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
          if (cause === "expired") f.w.clock.advance(13 * 60 * 60 * 1000);
          else for (let i = 0; i < 64; i++) await f.bootstrap();
          expect(f.timers.size).toBe(1); // No timer has fired; the broadcast must itself check liveness.
          if (source === "action") await f.broadcast();
          else if (source === "file-watch")
            await writeFile(join(f.w.dirs.records, "notification.tmp"), "fixture");
          else for (const tick of f.timers.values()) tick();
          expect((await boundedRead(reader)).done).toBe(true);
          expect(f.timers.size).toBe(0);
          expect(f.clear).toHaveBeenCalledTimes(1);
          f.server.stop();
          expect(f.clear).toHaveBeenCalledTimes(1);
        } finally {
          f.cleanup();
        }
      });
    }
  }

  test("heartbeats do not slide the session expiry", async () => {
    const f = await fixture();
    try {
      const reader = await f.open(await f.bootstrap());
      await reader.read();
      f.w.clock.advance(11 * 60 * 60 * 1000);
      for (const tick of f.timers.values()) tick();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("heartbeat");
      f.w.clock.advance(2 * 60 * 60 * 1000);
      for (const tick of f.timers.values()) tick();
      expect((await reader.read()).done).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  for (const cause of ["abort", "cancel", "stop"] as const) {
    test(`${cause} disposes once and detaches the abort listener, timer and broadcast sender`, async () => {
      const f = await fixture();
      try {
        const abort = new AbortController();
        const reader = await f.open(await f.bootstrap(), abort.signal);
        await reader.read();
        if (cause === "abort") abort.abort();
        else if (cause === "cancel") await reader.cancel();
        else f.server.stop();
        expect((await reader.read()).done).toBe(true);
        expect(f.timers.size).toBe(0);
        expect(f.clear).toHaveBeenCalledTimes(1);
        // All cleanup paths may run again, and a new action must not enqueue on the disposed stream.
        abort.abort();
        if (cause !== "stop") await f.broadcast();
        f.server.stop();
        expect(f.clear).toHaveBeenCalledTimes(1);
      } finally {
        f.cleanup();
      }
    });
  }

  test("an already aborted request cannot register a timer or enqueue its connected event", async () => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      abort.abort();
      const reader = await f.open(await f.bootstrap(), abort.signal);
      expect((await reader.read()).done).toBe(true);
      expect(f.timers.size).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  for (const initial of [true, false]) {
    test(`failed ${initial ? "initial" : "broadcast"} enqueue closes and disposes without resurrecting a timer`, async () => {
      const f = await fixture();
      let controllerPrototype: ReadableStreamDefaultController<Uint8Array> | undefined;
      new ReadableStream<Uint8Array>({
        start(controller) {
          controllerPrototype = Object.getPrototypeOf(controller);
          controller.close();
        },
      });
      if (!controllerPrototype) throw new Error("no controller prototype");
      const origEnqueue = controllerPrototype.enqueue;
      let shouldFail = false;
      let sseCalls = 0;
      const enqueue = spyOn(controllerPrototype, "enqueue").mockImplementation(function (
        this: ReadableStreamDefaultController<Uint8Array>,
        ...args: [Uint8Array?]
      ) {
        const chunk = args[0];
        const isSse =
          chunk instanceof Uint8Array &&
          chunk.length >= 5 &&
          chunk[0] === 100 && // 'd'
          chunk[1] === 97 && // 'a'
          chunk[2] === 116 && // 't'
          chunk[3] === 97 && // 'a'
          chunk[4] === 58; // ':'
        if (isSse) {
          sseCalls++;
          if (shouldFail) {
            shouldFail = false;
            throw new Error("failed enqueue");
          }
        }
        return origEnqueue.apply(this, args as [Uint8Array]);
      });
      try {
        const session = await f.bootstrap();
        if (initial) shouldFail = true;
        const reader = await f.open(session);
        if (!initial) {
          await reader.read();
          shouldFail = true;
          await f.broadcast();
        }
        expect((await boundedRead(reader)).done).toBe(true);
        expect(f.timers.size).toBe(0);
        const calls = sseCalls;
        await f.broadcast();
        expect(sseCalls).toBe(calls);
      } finally {
        enqueue.mockRestore();
        f.cleanup();
      }
    });
  }
});
