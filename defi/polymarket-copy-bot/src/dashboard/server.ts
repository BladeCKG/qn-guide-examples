import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DashboardStore } from './store.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export class DashboardServer {
  private readonly store: DashboardStore;
  private readonly port: number;
  private readonly publicDir: string;
  private readonly clients = new Set<ServerResponse>();
  private server = createServer(this.handleRequest.bind(this));

  constructor(store: DashboardStore, port: number) {
    this.store = store;
    this.port = port;
    this.publicDir = path.resolve(process.cwd(), 'public');
    this.store.subscribe((state) => {
      this.broadcast('state', state);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${this.port}`}`);

    if (url.pathname === '/api/state') {
      this.json(res, this.store.getState());
      return;
    }

    if (url.pathname === '/api/events') {
      this.handleSse(res);
      return;
    }

    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    await this.serveStatic(filePath, res);
  }

  private handleSse(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.clients.add(res);
    this.writeEvent(res, 'state', this.store.getState());

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    res.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  private async serveStatic(requestPath: string, res: ServerResponse): Promise<void> {
    const safePath = path.normalize(requestPath.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
    const finalPath = path.join(this.publicDir, safePath);

    try {
      const body = await readFile(finalPath);
      const ext = path.extname(finalPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  private json(res: ServerResponse, payload: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }

  private broadcast(eventName: string, payload: unknown): void {
    for (const client of this.clients) {
      this.writeEvent(client, eventName, payload);
    }
  }

  private writeEvent(res: ServerResponse, eventName: string, payload: unknown): void {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
