import base64 from "base64-js";
import type { TiktokenModel } from "./ranks/ranks";
import { never } from "./utils";

type BPEMergeNode = {
  listNext: BPEMergeNode | null;
  listPrev: BPEMergeNode | null;

  deleted: boolean;
  updated: boolean;
  updatedRank: number;
  removed: boolean;

  rank: number;
  start: number;
  end: number;
};

function compareNode (a:BPEMergeNode, b:BPEMergeNode) {
  return a.rank - b.rank || a.start - b.start;
}

// Helper function to swap elements at two indices
function swap(heap:BPEMergeNode[], i:number, j:number) {
  const temp = heap[i];
  heap[i] = heap[j];
  heap[j] = temp;
}

// Function to push an element onto the heap
function heapPush(heap:BPEMergeNode[], part:BPEMergeNode) {
  heap.push(part); // Add the new element to the end
  let currentIndex = heap.length - 1;
  let parentIndex = Math.floor((currentIndex - 1) / 2);

  // Bubble the new element up to its correct position
  while (currentIndex > 0 && compareNode(heap[currentIndex], heap[parentIndex]) < 0) {
    swap(heap, currentIndex, parentIndex);
    currentIndex = parentIndex;
    parentIndex = Math.floor((currentIndex - 1) / 2);
  }
}

// Function to pop the root element from the heap
function heapPop(heap:BPEMergeNode[]) {
  if (heap.length === 0) {
    return undefined; // Return undefined if the heap is empty
  }

  const rootValue = heap[0]; // The root element to return
  const lastValue = heap.pop(); // Remove the last element

  if (heap.length > 0 && lastValue) {
    heap[0] = lastValue; // Move the last element to the root
    let currentIndex = 0;

    // Bubble down the new root element to its correct position
    while (true) {
      let leftChildIndex = 2 * currentIndex + 1;
      let rightChildIndex = 2 * currentIndex + 2;
      let smallestIndex = currentIndex;

      if (leftChildIndex < heap.length && compareNode(heap[leftChildIndex], heap[smallestIndex]) < 0) {
        smallestIndex = leftChildIndex;
      }

      if (rightChildIndex < heap.length && compareNode(heap[rightChildIndex], heap[smallestIndex]) < 0) {
        smallestIndex = rightChildIndex;
      }

      if (smallestIndex !== currentIndex) {
        swap(heap, currentIndex, smallestIndex);
        currentIndex = smallestIndex;
      } else {
        break;
      }
    }
  }

  return rootValue;
}

function bytePairMerge(
  piece: Uint8Array,
  ranks: Map<string, number>
): Array<{ start: number; end: number }> {
  const parts: BPEMergeNode[] = Array.from({ length: piece.length }, (_, i) => ({
    start: i,
    end: i + 1,
    rank: 0,
    deleted: false,
    updated: false,
    updatedRank: 0,
    removed: true,
    listNext: null,
    listPrev: null
  }));

  const head = parts[0];
  for (let i = 0; i < parts.length; ++i) {
    parts[i].listPrev = parts[i - 1] ?? null;
    parts[i].listNext = parts[i + 1] ?? null;
  }

  const heap:BPEMergeNode[] = []
  for (let i = 0; i < parts.length - 1; ++i) {
    const slice = piece.slice(parts[i].start, parts[i + 1].end);
    const rank = ranks.get(slice.join(","));
    if (rank == null)
      continue;
    const part = parts[i];
    part.removed = false;
    part.rank = rank;
    heapPush(heap, part);
  }

  while (heap.length > 0) {
    const part = heapPop(heap);
    if (!part)
      break;

    // remove deleted nodes from heap
    if (part.deleted) {
      part.deleted = false;
      part.removed = true;
      continue
    }

    // reinsert updated nodes
    if (part.updated) {
      part.rank = part.updatedRank;
      part.updated = false;
      heapPush(heap, part);
      continue;
    }

    // mark node as removed from heap
    part.removed = true

    // delete next part and collapse node
    part.end = part.listNext?.end ?? piece.length;
    if (part.listNext)
      part.listNext.deleted = true;
    part.listNext = part.listNext?.listNext ?? null;

    // update rank
    if (part.listNext) {
      part.listNext.listPrev = part;
      const slice = piece.slice(part.start, part.listNext.end);
      const rank = ranks.get(slice.join(","));
      if (rank != null) {
        part.removed = false;
        part.rank = rank;
        heapPush(heap, part);
      }
    }

    // update previous part rank
    if (part.listPrev) {
      const prevSlice = piece.slice(part.listPrev.start, part.end);
      const prevRank = ranks.get(prevSlice.join(","));
      if (prevRank != null) {
        if (prevRank !== part.listPrev.rank) {
          if (part.listPrev.removed) {
            part.listPrev.removed = false
            part.listPrev.rank = prevRank;
            heapPush(heap, part)
          } else {
            part.listPrev.updated = true;
            part.listPrev.updatedRank = prevRank;
          }
        }
      } else {
        part.listPrev.deleted = true;
      }
    }
  }

  const result: Array<{ start: number; end: number }> = [];
  for (let node: BPEMergeNode | null = head; !!node; node = node.listNext) {
    result.push({ start: node.start, end: node.end });
  }
  return result;
}

function bytePairEncode(piece: Uint8Array, ranks: Map<string, number>) {
  if (piece.length === 1) return [ranks.get(piece.join(","))!];

  return bytePairMerge(piece, ranks)
    .map((p) => ranks.get(piece.slice(p.start, p.end).join(",")))
    .filter((x): x is number => x != null);
}

function escapeRegex(str: string) {
  return str.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

export interface TiktokenBPE {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

export class Tiktoken {
  /** @internal */
  protected specialTokens: Record<string, number>;

  /** @internal */
  protected inverseSpecialTokens: Record<number, Uint8Array>;

  /** @internal */
  protected patStr: string;

  /** @internal */
  protected textEncoder = new TextEncoder();

  /** @internal */
  protected textDecoder = new TextDecoder("utf-8");

  /** @internal */
  protected rankMap = new Map<string, number>();

  /** @internal */
  protected textMap = new Map<number, Uint8Array>();

  constructor(
    ranks: TiktokenBPE,
    extendedSpecialTokens?: Record<string, number>
  ) {
    this.patStr = ranks.pat_str;

    const uncompressed = ranks.bpe_ranks
      .split("\n")
      .filter(Boolean)
      .reduce<Record<string, number>>((memo, x) => {
        const [_, offsetStr, ...tokens] = x.split(" ");
        const offset = Number.parseInt(offsetStr, 10);
        tokens.forEach((token, i) => (memo[token] = offset + i));
        return memo;
      }, {});

    for (const [token, rank] of Object.entries(uncompressed)) {
      const bytes = base64.toByteArray(token);
      this.rankMap.set(bytes.join(","), rank);
      this.textMap.set(rank, bytes);
    }

    this.specialTokens = { ...ranks.special_tokens, ...extendedSpecialTokens };
    this.inverseSpecialTokens = Object.entries(this.specialTokens).reduce<
      Record<number, Uint8Array>
    >((memo, [text, rank]) => {
      memo[rank] = this.textEncoder.encode(text);
      return memo;
    }, {});
  }

  private static specialTokenRegex = (tokens: string[]) => {
    return new RegExp(tokens.map((i) => escapeRegex(i)).join("|"), "g");
  };

  encode(
    text: string,
    allowedSpecial: Array<string> | "all" = [],
    disallowedSpecial: Array<string> | "all" = "all"
  ) {
    const regexes = new RegExp(this.patStr, "ug");
    const specialRegex = Tiktoken.specialTokenRegex(
      Object.keys(this.specialTokens)
    );

    const ret: number[] = [];

    const allowedSpecialSet = new Set(
      allowedSpecial === "all"
        ? Object.keys(this.specialTokens)
        : allowedSpecial
    );

    const disallowedSpecialSet = new Set(
      disallowedSpecial === "all"
        ? Object.keys(this.specialTokens).filter(
            (x) => !allowedSpecialSet.has(x)
          )
        : disallowedSpecial
    );

    if (disallowedSpecialSet.size > 0) {
      const disallowedSpecialRegex = Tiktoken.specialTokenRegex([
        ...disallowedSpecialSet,
      ]);

      const specialMatch = text.match(disallowedSpecialRegex);
      if (specialMatch != null) {
        throw new Error(
          `The text contains a special token that is not allowed: ${specialMatch[0]}`
        );
      }
    }

    let start = 0;
    while (true) {
      let nextSpecial: RegExpMatchArray | null = null;
      let startFind = start;

      while (true) {
        specialRegex.lastIndex = startFind;
        nextSpecial = specialRegex.exec(text);
        if (nextSpecial == null || allowedSpecialSet.has(nextSpecial[0])) break;
        startFind = nextSpecial.index! + 1;
      }

      const end = nextSpecial?.index ?? text.length;
      for (const match of text.substring(start, end).matchAll(regexes)) {
        const piece = this.textEncoder.encode(match[0]);
        const token = this.rankMap.get(piece.join(","));

        if (token != null) {
          ret.push(token);
          continue;
        }

        ret.push(...bytePairEncode(piece, this.rankMap));
      }

      if (nextSpecial == null) break;
      let token = this.specialTokens[nextSpecial[0]];
      ret.push(token);

      start = nextSpecial.index! + nextSpecial[0].length;
    }

    return ret;
  }

  decode(tokens: number[]) {
    const res: Uint8Array[] = [];
    let length = 0;
    for (let i = 0; i < tokens.length; ++i) {
      const token = tokens[i];
      const bytes = this.textMap.get(token) ?? this.inverseSpecialTokens[token];

      if (bytes != null) {
        res.push(bytes);
        length += bytes.length;
      }
    }

    const mergedArray = new Uint8Array(length);
    let i = 0;
    for (const bytes of res) {
      mergedArray.set(bytes, i);
      i += bytes.length;
    }

    return this.textDecoder.decode(mergedArray);
  }
}

export function getEncodingNameForModel(model: TiktokenModel) {
  switch (model) {
    case "gpt2": {
      return "gpt2";
    }
    case "code-cushman-001":
    case "code-cushman-002":
    case "code-davinci-001":
    case "code-davinci-002":
    case "cushman-codex":
    case "davinci-codex":
    case "davinci-002":
    case "text-davinci-002":
    case "text-davinci-003": {
      return "p50k_base";
    }
    case "code-davinci-edit-001":
    case "text-davinci-edit-001": {
      return "p50k_edit";
    }
    case "ada":
    case "babbage":
    case "babbage-002":
    case "code-search-ada-code-001":
    case "code-search-babbage-code-001":
    case "curie":
    case "davinci":
    case "text-ada-001":
    case "text-babbage-001":
    case "text-curie-001":
    case "text-davinci-001":
    case "text-search-ada-doc-001":
    case "text-search-babbage-doc-001":
    case "text-search-curie-doc-001":
    case "text-search-davinci-doc-001":
    case "text-similarity-ada-001":
    case "text-similarity-babbage-001":
    case "text-similarity-curie-001":
    case "text-similarity-davinci-001": {
      return "r50k_base";
    }
    case "gpt-3.5-turbo-instruct-0914":
    case "gpt-3.5-turbo-instruct":
    case "gpt-3.5-turbo-16k-0613":
    case "gpt-3.5-turbo-16k":
    case "gpt-3.5-turbo-0613":
    case "gpt-3.5-turbo-0301":
    case "gpt-3.5-turbo":
    case "gpt-4-32k-0613":
    case "gpt-4-32k-0314":
    case "gpt-4-32k":
    case "gpt-4-0613":
    case "gpt-4-0314":
    case "gpt-4":
    case "gpt-3.5-turbo-1106":
    case "gpt-35-turbo":
    case "gpt-4-1106-preview":
    case "gpt-4-vision-preview":
    case "gpt-3.5-turbo-0125":
    case "gpt-4-turbo":
    case "gpt-4-turbo-2024-04-09":
    case "gpt-4-turbo-preview":
    case "gpt-4-0125-preview":
    case "text-embedding-ada-002": {
      return "cl100k_base";
    }
    default:
      never(model);
      throw new Error("Unknown model");
  }
}
