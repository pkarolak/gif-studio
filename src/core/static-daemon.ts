import {createServer} from 'node:http';
import path from 'node:path';
import {serveStatic} from './static-server.js';

const root = path.resolve(process.argv[2] ?? '.');
const server = createServer(serveStatic(root));
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Serving ${root} at http://localhost:${address.port}`);
});
