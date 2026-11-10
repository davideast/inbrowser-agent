import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const root = path.join(pkgRoot, 'dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};
const workerCsp = "worker-src 'self' blob:; object-src 'none'; base-uri 'none'";
const hostHtml =
  '<!doctype html><meta charset="utf-8"><title>@inbrowser/node E2E</title><body></body>\n';

const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hostHtml);
      return;
    }
    if (pathname === '/kernel.js' || pathname === '/process.js') {
      res.setHeader('Content-Security-Policy', workerCsp);
    }
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(filename);
    res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const port = Number(process.env.PORT) || 4173;
server.on('error', (error) => {
  console.error(`E2E host server: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`E2E host: http://127.0.0.1:${port}`));

const previewRoot = path.join(root, 'preview-origin');
const previewFiles = {
  '/__inbrowser_preview_sw.js': [
    '__inbrowser_preview_sw.js',
    'text/javascript; charset=utf-8',
    200,
  ],
  '/__inbrowser__/bridge.html': ['__inbrowser__/bridge.html', 'text/html; charset=utf-8', 200],
};
const preview = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const [file, type, status] = previewFiles[pathname] ?? [
    '__inbrowser__/unavailable.html',
    'text/html; charset=utf-8',
    503,
  ];
  try {
    const data = await readFile(path.join(previewRoot, file));
    res.writeHead(status, { 'Content-Type': type }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
const previewPort = Number(process.env.PREVIEW_PORT) || port + 1;
preview.on('error', (error) => {
  console.error(`Preview origin server: ${error.message}`);
  process.exit(1);
});
preview.listen(previewPort, '127.0.0.1', () =>
  console.log(`Preview origins: http://<container>-<port>.localhost:${previewPort}`),
);

const extraSandboxParents = (process.env.SANDBOX_ALLOWED_PARENT_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const sandboxAllowedParents = [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...extraSandboxParents,
];
const sandboxHtml = `<!doctype html>
<meta charset="utf-8" />
<script type="module">
  import { installSandboxHost } from '/runtime.js';
  installSandboxHost({
    allowedParentOrigins: ${JSON.stringify(sandboxAllowedParents)},
    bootOptions: {
      preview: {
        origin: 'http://{container}-{port}.localhost:${previewPort}',
        embedderPolicy: 'require-corp',
      },
    },
  });
</script>
`;
const sandbox = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/sandbox.html' || pathname === '/__inbrowser_sandbox__.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(sandboxHtml);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hostHtml);
      return;
    }
    if (pathname === '/kernel.js' || pathname === '/process.js') {
      res.setHeader('Content-Security-Policy', workerCsp);
    }
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(filename);
    res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
const sandboxPort = Number(process.env.SANDBOX_PORT) || port + 2;
sandbox.on('error', (error) => {
  console.error(`Sandbox origin server: ${error.message}`);
  process.exit(1);
});
sandbox.listen(sandboxPort, '127.0.0.1', () =>
  console.log(`Sandbox host: http://sandbox.localhost:${sandboxPort}/sandbox.html`),
);
