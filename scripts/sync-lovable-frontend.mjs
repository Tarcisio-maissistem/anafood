import fs from 'node:fs/promises';
import path from 'node:path';

const FRONTEND_URL = process.env.LOVABLE_FRONTEND_URL || 'https://ana-food-delivery.lovable.app';
const OUTPUT_DIR = path.resolve('public', 'lovable');

const ensureDir = async (filePath) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const cleanOutputDir = async () => {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
};

const toAbsoluteUrl = (relativePath) => new URL(relativePath, FRONTEND_URL).toString();

const collectAssetPaths = (html) => {
  const paths = new Set(['/']);
  const regex = /(src|href)=["']([^"']+)["']/gi;
  let match = null;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[2].trim();
    if (!raw) continue;
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('//')) continue;
    if (!raw.startsWith('/')) continue;
    if (raw.startsWith('/~')) continue;
    if (raw.includes('?')) {
      paths.add(raw.split('?')[0]);
      continue;
    }
    paths.add(raw);
  }
  return Array.from(paths);
};

const downloadFile = async (assetPath) => {
  const absoluteUrl = toAbsoluteUrl(assetPath);
  const response = await fetch(absoluteUrl);
  if (!response.ok) throw new Error(`Falha ao baixar ${absoluteUrl} (${response.status})`);
  const content = Buffer.from(await response.arrayBuffer());

  const localPath = assetPath === '/'
    ? path.join(OUTPUT_DIR, 'index.html')
    : path.join(OUTPUT_DIR, assetPath.slice(1));

  await ensureDir(localPath);
  await fs.writeFile(localPath, content);
  return localPath;
};

async function main() {
  const rootRes = await fetch(FRONTEND_URL);
  if (!rootRes.ok) throw new Error(`Falha ao acessar ${FRONTEND_URL} (${rootRes.status})`);
  const rootHtml = await rootRes.text();

  await cleanOutputDir();
  const assetPaths = collectAssetPaths(rootHtml);

  const downloaded = [];
  for (const assetPath of assetPaths) {
    const savedPath = await downloadFile(assetPath);
    downloaded.push(savedPath);
  }

  const manifestPath = path.join(OUTPUT_DIR, 'sync-manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        source: FRONTEND_URL,
        syncedAt: new Date().toISOString(),
        files: downloaded.map((p) => path.relative(OUTPUT_DIR, p).replace(/\\/g, '/')),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`Lovable frontend sincronizado em ${OUTPUT_DIR}`);
  console.log(`Arquivos baixados: ${downloaded.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
