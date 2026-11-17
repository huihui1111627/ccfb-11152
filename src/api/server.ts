import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { getDb } from '../db/index.js';
import { handleApi } from './routes.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(process.cwd(), 'src/web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  // 防路径穿越
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, safePath);
  if (!existsSync(filePath) || extname(filePath) === '') {
    // SPA 回退
    filePath = join(PUBLIC_DIR, 'index.html');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const db = getDb('data/slo.db');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  try {
    if (url.pathname.startsWith('/api/')) {
      let body: unknown = {};
      if (method === 'POST' || method === 'PUT') body = await readBody(req);
      const result = await handleApi(db, method, url.pathname, url.searchParams, body);
      if (result.raw !== undefined) {
        res.writeHead(result.status, {
          'Content-Type': result.contentType ?? 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="slo-weekly-export.csv"`,
        });
        res.end(result.raw);
        return;
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('JSON') || msg.includes('必填') || msg.includes('过大') ? 400 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: msg }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🚗 充电桩 SLO 管理平台已启动:  http://localhost:${PORT}`);
  console.log(`   页面目录:服务目录 / SLO 定义 / 错误预算 / 告警 / 发布闸门 / 依赖图 / 评估报告\n`);
});
