/**
 * Build the chunk-level embedding index consumed by semantic + hybrid
 * retrieval (src/lib/semantic-retrieval.ts).
 *
 * Design source: plans/retrieval-hardening.md (Phase 1).
 *
 * Reads the enriched content graph (src/generated/docs-graph.json), splits
 * each node's markdown `body` into section chunks by heading, embeds each
 * chunk with Xenova/all-MiniLM-L6-v2 (384-dim, mean-pooled + L2-normalized),
 * and writes src/generated/chunk-index.json.
 *
 * Chunking: each chunk = a heading line + its content up to the next heading.
 * Any preamble before the first heading becomes its own (heading-less) chunk.
 * Very long sections are further split on paragraph boundaries to ~1200 chars
 * so a chunk stays focused enough for a single embedding.
 *
 *   bun run scripts/build-chunk-index.ts
 *
 * Downloads the model (~23 MB) on first run, then caches it.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from '@huggingface/transformers';
import graphData from '../src/generated/docs-graph.json';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
/** Soft cap for a single chunk's text before paragraph-splitting kicks in. */
const MAX_CHUNK_CHARS = 1200;

interface GraphNode {
  route: string;
  title: string;
  body: string;
}
interface GraphFile {
  nodes: GraphNode[];
}

interface RawChunk {
  id: string;
  route: string;
  docTitle: string;
  heading: string;
  text: string;
}

/** A heading line + the body that follows it, before sub-splitting. */
interface Section {
  heading: string;
  text: string;
}

const HEADING_RE = /^#{1,6}\s/;

/**
 * Split a markdown body into sections by heading. Returns the preamble (text
 * before the first heading, heading: '') followed by each heading's section.
 * Empty sections are dropped.
 */
function splitSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text.length > 0 || heading.length > 0) {
      sections.push({ heading, text });
    }
    buf = [];
  };

  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      flush();
      // Strip the leading "## " markers from the heading text.
      heading = line.replace(/^#{1,6}\s+/, '').trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  // Drop fully-empty sections (heading with no body AND no heading text).
  return sections.filter((s) => s.heading.length > 0 || s.text.length > 0);
}

/**
 * If a section's text is longer than MAX_CHUNK_CHARS, split it on blank-line
 * paragraph boundaries, greedily packing paragraphs into ~MAX_CHUNK_CHARS
 * pieces. Short sections pass through unchanged (one piece).
 */
function splitLongSection(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length === 0) {
      cur = p;
    } else if (cur.length + 2 + p.length <= MAX_CHUNK_CHARS) {
      cur = `${cur}\n\n${p}`;
    } else {
      pieces.push(cur);
      cur = p;
    }
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces.length > 0 ? pieces : [text];
}

/** Slugify a heading for stable chunk ids. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function chunkNode(node: GraphNode): RawChunk[] {
  const chunks: RawChunk[] = [];
  for (const section of splitSections(node.body)) {
    const pieces = splitLongSection(section.text);
    pieces.forEach((piece, i) => {
      // Skip pieces that are empty after sub-splitting (heading-only sections
      // keep one chunk so the heading text itself is searchable).
      const text = piece.trim();
      const headSlug = slug(section.heading) || 'preamble';
      const suffix = pieces.length > 1 ? `-${i}` : '';
      chunks.push({
        id: `${node.route}#${headSlug}${suffix}`,
        route: node.route,
        docTitle: node.title,
        heading: section.heading,
        text,
      });
    });
  }
  return chunks;
}

/** Mean-pool a [tokens x dim] tensor over tokens, then L2-normalize. */
function meanPoolNormalize(data: Float32Array, dims: number[]): number[] {
  // Transformers.js feature-extraction returns [batch=1, tokens, dim] OR,
  // with pooling already applied, [batch=1, dim]. Handle the 2-D query path
  // here only as a fallback; we request pooling 'none' to mean-pool ourselves.
  let tokens: number;
  let dim: number;
  if (dims.length === 3) {
    tokens = dims[1];
    dim = dims[2];
  } else {
    tokens = 1;
    dim = dims[dims.length - 1];
  }
  const out = new Float32Array(dim);
  for (let t = 0; t < tokens; t++) {
    const base = t * dim;
    for (let d = 0; d < dim; d++) out[d] += data[base + d];
  }
  for (let d = 0; d < dim; d++) out[d] /= tokens;
  // L2-normalize.
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += out[d] * out[d];
  norm = Math.sqrt(norm) || 1;
  const vec: number[] = new Array(dim);
  for (let d = 0; d < dim; d++) vec[d] = out[d] / norm;
  return vec;
}

function round6(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1e6) / 1e6);
}

async function main() {
  const graph = graphData as GraphFile;

  const raw: RawChunk[] = [];
  for (const node of graph.nodes) {
    raw.push(...chunkNode(node));
  }
  console.log(`Chunked ${graph.nodes.length} docs into ${raw.length} chunks.`);

  console.log(`Loading embedder ${MODEL} (downloads ~23 MB on first run)...`);
  const extractor = await pipeline('feature-extraction', MODEL);

  const chunks: (RawChunk & { vector: number[] })[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    // Give the chunk its doc + section context, matching embedQuery's input
    // shape only loosely (queries have no doc/heading) — the doc/heading
    // prefix sharpens which section a chunk is.
    const input = `${c.docTitle} — ${c.heading}\n${c.text}`;
    const tensor = await extractor(input, { pooling: 'none' });
    const vec = meanPoolNormalize(tensor.data as Float32Array, tensor.dims as number[]);
    if (vec.length !== DIM) {
      throw new Error(`chunk ${c.id} produced dim ${vec.length}, expected ${DIM}`);
    }
    chunks.push({ ...c, vector: round6(vec) });
    if ((i + 1) % 50 === 0) console.log(`  embedded ${i + 1}/${raw.length}`);
  }

  const outDir = path.resolve(import.meta.dir, '../src/generated');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'chunk-index.json');
  const payload = { dim: DIM, model: MODEL, chunks };
  writeFileSync(outFile, JSON.stringify(payload));

  const bytes = statSync(outFile).size;
  const kb = (bytes / 1024).toFixed(1);
  console.log(`Wrote ${outFile}`);
  console.log(`  chunks: ${chunks.length}`);
  console.log(`  size:   ${kb} KB (${bytes} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
