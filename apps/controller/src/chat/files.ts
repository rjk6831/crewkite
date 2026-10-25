import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { type ChatAttachment, ChatAttachmentSchema } from '@crewkite/contracts';

// Files the person attaches to a thread live under the controller home, never in the scratch copy,
// so Accept can never carry them into the repository. Each file sits at `<sha256>/<name>`. The
// name keeps its extension because some clients detect the type from it.

/** The thread's files folder. Delete removes it with the rest of the thread's folder. */
export function filesFolder(home: string, taskId: string): string {
  return join(home, 'chat', taskId, 'files');
}

/** A source CrewKite will not store, with a message the person can act on. */
export class FileRefused extends Error {}

export type FileSource = { path: string } | { name: string; mimeType: string; base64: string };

const CHUNK_BYTES = 1024 * 1024;
// Type detection reads the start of the file. Office files name their parts in the first entries.
const HEAD_BYTES = 64 * 1024;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/i;

/**
 * Copy one file into the folder and name it by the hash of its bytes. A path is read in chunks,
 * so a large file never sits whole in memory. The same bytes stored before are kept, and a new
 * name for them is a hard link to the stored copy.
 */
export function storeFile(folder: string, source: FileSource): ChatAttachment {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.import-${randomBytes(8).toString('hex')}`);
  try {
    const read =
      'path' in source ? copyFrom(source.path, temporary) : writeBytes(source.base64, temporary);
    const name = fileName('path' in source ? basename(source.path) : source.name);
    const attachment = ChatAttachmentSchema.parse({
      id: read.hash,
      name,
      mimeType: detectType(read.head, name, 'path' in source ? null : source.mimeType),
      bytes: read.bytes,
    });
    place(folder, attachment, temporary);
    return attachment;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Where a stored file is, or null when this thread holds no file with that id, name and size. */
export function storedFile(folder: string, attachment: ChatAttachment): string | null {
  const path = join(folder, attachment.id, attachment.name);
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size === attachment.bytes ? path : null;
  } catch {
    return null;
  }
}

type Read = { hash: string; bytes: number; head: Buffer };

function copyFrom(path: string, temporary: string): Read {
  let input: number;
  try {
    // A pipe would block an ordinary open until something writes to it.
    input = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new FileRefused(
      code === 'ENOENT'
        ? 'The file is no longer there. Pick it again.'
        : 'The file could not be opened. Check that you can read it, then attach it again.',
    );
  }
  try {
    const stat = fstatSync(input);
    if (stat.isDirectory()) throw new FileRefused('Attach the files inside the folder one by one.');
    if (!stat.isFile())
      throw new FileRefused(
        'Only regular files can be attached. Devices, sockets and pipes cannot.',
      );
    const output = openSync(temporary, 'wx', 0o600);
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const head: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        let count: number;
        try {
          count = readSync(input, buffer, 0, CHUNK_BYTES, null);
        } catch {
          throw new FileRefused('The file could not be read to the end. Attach it again.');
        }
        if (count === 0) break;
        const chunk = buffer.subarray(0, count);
        hash.update(chunk);
        if (bytes < HEAD_BYTES) head.push(Buffer.from(chunk.subarray(0, HEAD_BYTES - bytes)));
        for (let written = 0; written < count; )
          written += writeSync(output, chunk, written, count - written);
        bytes += count;
      }
      return { hash: hash.digest('hex'), bytes, head: Buffer.concat(head) };
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}

function writeBytes(base64: string, temporary: string): Read {
  const data = Buffer.from(base64, 'base64');
  writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  return {
    hash: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    head: data.subarray(0, HEAD_BYTES),
  };
}

function place(folder: string, attachment: ChatAttachment, temporary: string) {
  const directory = join(folder, attachment.id);
  const target = join(directory, attachment.name);
  if (storedFile(folder, attachment)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  const stored = readdirSync(directory)
    .map((name) => join(directory, name))
    .find((path) => {
      const stat = lstatSync(path);
      return stat.isFile() && stat.size === attachment.bytes;
    });
  if (!stored) {
    renameSync(temporary, target);
    return;
  }
  try {
    linkSync(stored, target);
  } catch {
    copyFileSync(stored, target);
  }
}

/** A name the schema accepts and the file system can hold: no folder part, at most 255 bytes. */
function fileName(raw: string): string {
  const name = raw
    .toWellFormed()
    .replace(/[/\\\p{Cc}]/gu, '_')
    .trim();
  if (!name || name === '.' || name === '..') return 'file';
  if (Buffer.byteLength(name) <= 255) return name;
  const extension = extname(name).slice(0, 32);
  let stem = name.slice(0, name.length - extension.length);
  while (Buffer.byteLength(stem + extension) > 255) stem = stem.slice(0, -1).toWellFormed();
  return stem + extension;
}

/**
 * The type the bytes show, then the extension, then what a paste declared. The name only says
 * what the file is. CrewKite refuses no type, and each provider decides what it takes.
 */
export function detectType(head: Buffer, name: string, declared: string | null): string {
  const sniffed = sniff(head);
  if (sniffed === 'application/zip') return zipType(head) ?? byExtension(name) ?? sniffed;
  if (sniffed) return sniffed;
  const named = byExtension(name);
  if (named) return named;
  if (declared && MIME.test(declared) && declared !== 'application/octet-stream')
    return declared.toLowerCase();
  return 'application/octet-stream';
}

function sniff(head: Buffer): string | null {
  const at = (start: number, text: string) =>
    head.length >= start + text.length &&
    head.toString('latin1', start, start + text.length) === text;
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, '%PDF-')) return 'application/pdf';
  if (at(0, 'PK\x03\x04')) return 'application/zip';
  // An MPEG audio frame starts with eleven set bits, and layer III sets the next layer bits to 01.
  if (at(0, 'ID3') || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (at(4, 'ftyp')) {
    const brand = head.toString('latin1', 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (at(0, '\x1a\x45\xdf\xa3')) return head.includes('webm') ? 'video/webm' : 'video/x-matroska';
  if (at(0, 'OggS')) return head.includes('theora') ? 'video/ogg' : 'audio/ogg';
  return null;
}

/**
 * OpenDocument files store their type uncompressed as the first entry. Office Open XML files
 * name their parts under one folder per application.
 */
function zipType(head: Buffer): string | null {
  if (head.toString('latin1', 30, 38) === 'mimetype' && head.length >= 38) {
    const length = head.readUInt32LE(18);
    const type = head.toString('latin1', 38, 38 + Math.min(length, 128));
    if (length <= 128 && MIME.test(type)) return type;
  }
  if (head.includes('word/'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (head.includes('xl/'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (head.includes('ppt/'))
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return null;
}

function byExtension(name: string): string | null {
  return EXTENSIONS[extname(name).slice(1).toLowerCase()] ?? null;
}

// Source files map to text types, so a provider that reads text sees them as text. `.ts` would
// otherwise read as an MPEG transport stream.
const EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  sh: 'text/x-shellscript',
  sql: 'application/sql',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  zip: 'application/zip',
  gz: 'application/gzip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
};
