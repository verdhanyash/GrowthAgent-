/**
 * scripts/shot.mjs — screenshot a URL at a real emulated viewport.
 *
 * `chrome --headless --screenshot --window-size=390,x` does NOT emulate a phone:
 * it lays the page out at a desktop width and then crops to the window, which
 * makes a perfectly responsive page look like it overflows. Setting device
 * metrics over CDP is what actually narrows the viewport, so responsive checks
 * have to go through here rather than through the CLI flag.
 *
 * Usage: node scripts/shot.mjs <url> <out.png> [width] [height] [--full]
 * Requires Chrome listening on --remote-debugging-port=9222.
 */
import { writeFile } from "node:fs/promises";

const [, , url, out, wArg, hArg, ...rest] = process.argv;
if (!url || !out) throw new Error("usage: shot.mjs <url> <out.png> [w] [h] [--full]");
const width = Number(wArg ?? 1440);
const height = Number(hArg ?? 900);
const full = rest.includes("--full");

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target on :9222");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: width < 700,
});
await send("Page.enable");
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 7000));

const { data } = await send("Page.captureScreenshot", {
  format: "png",
  ...(full ? { captureBeyondViewport: true } : {}),
});
await writeFile(out, Buffer.from(data, "base64"));
console.log(`${out} (${width}x${height}${full ? " full-page" : ""})`);
ws.close();
