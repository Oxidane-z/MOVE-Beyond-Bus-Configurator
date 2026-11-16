import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

// 模型文件名不变而内容会变（重新转换 STEP），所以按内容哈希给地址加版本号，避免浏览器拿到缓存里的旧模型
const dir = new URL('./public/models/', import.meta.url);
const versions = {};
for (const f of readdirSync(dir)) {
  if (f.endsWith('.glb')) versions['models/' + f] = createHash('sha1').update(readFileSync(new URL(f, dir))).digest('hex').slice(0, 10);
}

// base './' 让构建产物可以放在任意子路径下（例如 GitHub Pages）
export default defineConfig({ base: './', define: { __MODEL_VERSIONS__: JSON.stringify(versions) } });
