// 最小 zip 读取器。
//
// 为什么自己写：插件后端不允许引第三方依赖，Node 内置只有 gzip/deflate，
// 而 GitHub Release 发的是 zip。这里只实现读，不做写。
// 覆盖范围：store(0) 与 deflate(8) 两种压缩方式，正好是 GitHub 打包用的。
// 不处理：ZIP64（>4GB）、加密、多卷。插件包不可能触及这些上限。
//
// 安全：解压前一律过一遍 safeRelativePath，挡掉 zip-slip（../ 或绝对路径）。

import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50; // 中央目录结尾
const CEN_SIG = 0x02014b50; // 中央目录条目
const LOC_SIG = 0x04034b50; // 本地文件头

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new Error("zip 数据必须是 Buffer / Uint8Array / ArrayBuffer");
}

/** EOCD 后面最多跟 65535 字节注释，所以从尾部往回扫这个范围。 */
function findEndOfCentralDirectory(buf) {
  const floor = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 列出 zip 里的所有条目（不解压数据）。
 * @returns {{ name: string, method: number, compressedSize: number, uncompressedSize: number, localOffset: number }[]}
 */
export function listEntries(input) {
  const buf = asBuffer(input);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error("不是有效的 zip：找不到中央目录");

  const total = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CEN_SIG) {
      throw new Error("zip 中央目录损坏");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** 取出单个条目解压后的内容。 */
export function readEntry(input, entry) {
  const buf = asBuffer(input);
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC_SIG) {
    throw new Error(`zip 本地头损坏：${entry.name}`);
  }
  const nameLength = buf.readUInt16LE(local + 26);
  const extraLength = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`暂不支持 zip 压缩方式 ${entry.method}（${entry.name}）`);
}

/**
 * 把条目名规范成相对路径；任何想往外爬的写法都直接拒绝。
 * @returns {string|null} 规范化后的相对路径（用 / 分隔），拒绝时返回 null
 */
export function safeRelativePath(name) {
  const raw = String(name || "").replace(/\\/g, "/").trim();
  if (!raw) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;

  const parts = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  if (!parts.length) return null;
  return parts.join("/");
}

/**
 * 把 zip 全量解成 { relativePath: Buffer }，跳过目录条目。
 * 大包不建议用这个（会把所有内容同时攥在内存里），插件包级别够用。
 */
export function extractAll(input) {
  const buf = asBuffer(input);
  const files = new Map();
  for (const entry of listEntries(buf)) {
    if (entry.name.endsWith("/")) continue; // 目录条目本身不产文件
    const safe = safeRelativePath(entry.name);
    if (!safe) throw new Error(`zip 中包含不安全的路径：${entry.name}`);
    files.set(safe, readEntry(buf, entry));
  }
  return files;
}

/**
 * 去掉 zip 自带的顶层目录。
 * GitHub 打包的源码/资产通常外面套一层 `repo-tag/`，插件目录不需要它。
 */
export function stripCommonRoot(files) {
  let root = null;
  for (const key of files.keys()) {
    const head = key.split("/")[0];
    if (root === null) root = head;
    else if (root !== head) return files;
  }
  if (root === null) return files;

  const prefix = `${root}/`;
  const stripped = new Map();
  for (const [key, value] of files) {
    if (!key.startsWith(prefix)) return files;
    stripped.set(key.slice(prefix.length), value);
  }
  // 只剩一个文件说明它不是"目录层级"，还原回去
  return stripped.size > 0 ? stripped : files;
}
