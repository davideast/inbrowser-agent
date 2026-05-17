import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface AudioStore {
  save(jobId: string, index: number, wav: Uint8Array): Promise<string>;
  saveFile(jobId: string, fileName: string, wav: Uint8Array): Promise<string>;
  read(jobId: string, index: number): Promise<Uint8Array | null>;
  readFile(jobId: string, fileName: string): Promise<Uint8Array | null>;
}

export function createFileAudioStore(rootDir: string): AudioStore {
  const root = resolve(rootDir);

  function filePathFor(jobId: string, fileName: string): string {
    assertSafeSegment(jobId);
    assertSafeFileName(fileName);
    return join(root, jobId, fileName);
  }

  async function saveFile(jobId: string, fileName: string, wav: Uint8Array): Promise<string> {
    const filePath = filePathFor(jobId, fileName);
    await mkdir(join(root, jobId), { recursive: true });
    await writeFile(filePath, wav);
    return `/audio/${encodeURIComponent(jobId)}/${fileName}`;
  }

  async function readStoredFile(jobId: string, fileName: string): Promise<Uint8Array | null> {
    try {
      return await readFile(filePathFor(jobId, fileName));
    } catch {
      return null;
    }
  }

  return {
    async save(jobId, index, wav) {
      return saveFile(jobId, `${index}.wav`, wav);
    },

    saveFile,

    async read(jobId, index) {
      return readStoredFile(jobId, `${index}.wav`);
    },

    readFile: readStoredFile,
  };
}

function assertSafeSegment(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('unsafe path segment');
  }
}

function assertSafeFileName(value: string): void {
  if (!/^[a-zA-Z0-9_-]+\.wav$/.test(value)) {
    throw new Error('unsafe file name');
  }
}
