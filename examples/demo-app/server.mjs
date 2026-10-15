import {createReadStream, existsSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const portFlag = process.argv.indexOf('--port');
const port = Number(process.env.PORT ?? (portFlag > -1 ? process.argv[portFlag + 1] : 4610));
const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml'};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(root, url.pathname);
  if (!file.startsWith(root) || !existsSync(file) || url.pathname === '/') file = path.join(root, 'index.html');
  res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream'});
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Plannr running at http://localhost:${port}`));
