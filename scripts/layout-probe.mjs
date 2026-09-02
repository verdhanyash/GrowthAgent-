/**
 * scripts/layout-probe.mjs — ask a real browser which element is too wide.
 *
 * Guessing at horizontal overflow from source is unreliable: the culprit is
 * whichever box ends up widest after layout, which depends on intrinsic content
 * widths you cannot read off a class list. So drive headless Chrome over CDP and
 * have the page itself report the offenders.
 *
 * Usage: node scripts/layout-probe.mjs <url> [viewportWidth]
 * Requires a Chrome already listening on --remote-debugging-port=9222.
 */
const url = process.argv[2] ?? "http://127.0.0.1:5274/";
const width = Number(process.argv[3] ?? 390);

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
  height: 900,
  deviceScaleFactor: 1,
  mobile: true,
});
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 6000));

const expression = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 || r.right > vw + 1) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 90),
        w: Math.round(r.width),
        right: Math.round(r.right),
        depth: (() => { let d = 0, n = el; while ((n = n.parentElement)) d++; return d; })(),
      });
    }
  }
  // Deepest first: the innermost offender is the cause, its ancestors are victims.
  out.sort((a, b) => b.depth - a.depth);
  return JSON.stringify({
    viewport: vw,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    offenders: out.slice(0, 14),
  }, null, 2);
})()`;

const { result } = await send("Runtime.evaluate", { expression, returnByValue: true });
console.log(result.value);
ws.close();
