// One-shot: evaluate an expression in the LoopDec renderer via CDP.
//   node scripts/cdp-eval.mjs "document.querySelector('.tile-edit-btn').click()"
// Requires Electron launched with --remote-debugging-port=9222.

const target = process.argv[2];
if (!target) { console.error('usage: cdp-eval.mjs <expression>'); process.exit(1); }

const pages = await fetch('http://localhost:9222/json').then(r => r.json());
const page = pages.find(p => p.type === 'page');
if (!page) { console.error('no debuggable page'); process.exit(1); }

const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => sock.addEventListener('open', resolve, { once: true }));

const reply = await new Promise((resolve) => {
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) resolve(m);
  }, { once: true });
  sock.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: target, returnByValue: true, awaitPromise: true },
  }));
});

console.log(JSON.stringify(reply.result?.result?.value ?? reply, null, 2));
sock.close();
