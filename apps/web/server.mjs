import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
const server = createServer(async (request, response) => {
  if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', service: 'clipcon-web' })); return; }
  const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const candidate = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
  const inside = relative(root, candidate);
  if (inside.startsWith(`..${sep}`) || inside === '..' || inside.includes(`..${sep}`)) { response.writeHead(404); response.end(); return; }
  try { const content = await readFile(candidate); const extension = candidate.split('.').pop(); response.writeHead(200, { 'content-type': types[extension] ?? 'application/octet-stream' }); response.end(content); }
  catch { const content = await readFile(resolve(root, 'index.html')); response.writeHead(200, { 'content-type': types.html }); response.end(content); }
});
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
