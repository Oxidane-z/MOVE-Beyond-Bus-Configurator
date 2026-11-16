// 颜色相关的纯函数：不依赖 three 和 DOM，可以单独测试。

// 元器件只用这几种材质色，不带 CAD 原色
export const MATERIALS = { dark: 0, light: 1, kapton: 2, gold: 3 };

// CAD 原色（线性空间，0–1）归到几种材质之一
export function classifyColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (max - min >= 0.25 * max && max > 0.08) {
    let hue;
    if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue *= 60;
    // 黄是金，棕是暗金；饱和的亮橙红是 CAD 给外壳的默认色，不算
    if (hue >= 40 && hue <= 70) return MATERIALS.gold;
    if (hue >= 20 && hue < 40 && max <= 0.85) return MATERIALS.kapton;
    // 蓝色是 CAD 给结构件（支架、散热器）的默认色，按金属处理
    if (hue >= 190 && hue <= 260) return MATERIALS.light;
  }
  return lum < 0.25 ? MATERIALS.dark : MATERIALS.light;
}

export const isDark = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255) < 70;
};

// WCAG 相对亮度（0–1）
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
}
export const contrast = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
// 色块上的文字：黑白两种里取对比度高的那个
const INK_DARK = '#25262b', INK_LIGHT = '#ffffff';
export const inkOn = hex => contrast(hex, INK_LIGHT) > contrast(hex, INK_DARK) ? INK_LIGHT : INK_DARK;
