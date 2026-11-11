// QR version 3-L, byte mode, one Reed-Solomon block, fixed mask 0.
// 55 data + 15 parity codewords; capacity 53 UTF-8 bytes.
export function qrMatrix(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > 53) throw new Error("QR input exceeds 53 bytes.");
  const bits = [];
  const append = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(4, 4);
  append(bytes.length, 8);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, 440 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let i = 0; data.length < 55; i++) data.push(i % 2 ? 0x11 : 0xec);
  const mul = (a, b) => {
    let result = 0;
    for (; b; b >>>= 1) { if (b & 1) result ^= a; a <<= 1; if (a & 256) a ^= 0x11d; }
    return result;
  };
  let generator = [1];
  let root = 1;
  for (let i = 0; i < 15; i++) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((v, j) => { next[j] ^= v; next[j + 1] ^= mul(v, root); });
    generator = next;
    root = mul(root, 2);
  }
  const remainder = [...data, ...Array(15).fill(0)];
  for (let i = 0; i < 55; i++) {
    const factor = remainder[i];
    generator.forEach((v, j) => { remainder[i + j] ^= mul(v, factor); });
  }
  const stream = [...data, ...remainder.slice(55)].flatMap(v => Array.from({ length: 8 }, (_, i) => (v >>> (7 - i)) & 1));
  const n = 29;
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < n && y < n) matrix[y][x] = Boolean(v); };
  for (const [cx, cy] of [[3, 3], [25, 3], [3, 25]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, d !== 2 && d !== 4);
    }
  }
  for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  const format = 0x77c4; // error correction L, mask 0, BCH encoded and masked
  const bit = i => (format >>> i) & 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
  set(8, n - 8, true);
  let index = 0;
  let upwards = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let v = 0; v < n; v++) {
      const y = upwards ? n - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (matrix[y][x] === null) set(x, y, (stream[index++] || 0) ^ ((x + y) % 2 === 0 ? 1 : 0));
      }
    }
    upwards = !upwards;
  }
  return matrix;
}

export function terminalQr(text) {
  const matrix = qrMatrix(text);
  const dark = (x, y) => matrix[y - 4]?.[x - 4] === true;
  const lines = [];
  for (let y = 0; y < 37; y += 2) {
    let line = "";
    for (let x = 0; x < 37; x++) line += dark(x, y) ? (dark(x, y + 1) ? "█" : "▀") : (dark(x, y + 1) ? "▄" : " ");
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}
