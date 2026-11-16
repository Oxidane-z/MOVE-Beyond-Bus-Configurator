import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// 模型文件名不变而内容会变（重新转换 STEP），所以按内容哈希给地址加版本号，避免浏览器拿到缓存里的旧模型
const dir = new URL('./public/models/', import.meta.url);
const versions = {};
for (const f of readdirSync(dir)) {
  if (f.endsWith('.glb')) versions['models/' + f] = createHash('sha1').update(readFileSync(new URL(f, dir))).digest('hex').slice(0, 10);
}

// 构建后给每个 GLB 生成一份 gzip 副本。静态托管不一定会压缩 .glb，查看器自己取 .glb.gz 并在浏览器里解压
const gzipModels = {
  name: 'gzip-models',
  apply: 'build',
  closeBundle() {
    const out = new URL('./dist/models/', import.meta.url);
    for (const f of readdirSync(out)) {
      if (f.endsWith('.glb')) writeFileSync(new URL(f + '.gz', out), gzipSync(readFileSync(new URL(f, out)), { level: 9 }));
    }
  }
};

// base './' 让构建产物可以放在任意子路径下（例如 GitHub Pages）
export default defineConfig(({ command }) => ({
  base: './',
  define: { __MODEL_VERSIONS__: JSON.stringify(versions), __MODELS_GZ__: command === 'build' },
  plugins: [gzipModels]
}));
