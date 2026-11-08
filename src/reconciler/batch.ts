import { OutputTruncatedError } from "../model/provider.js";

/**
 * Runs `run` over consecutive slices of at most `size` items (with each slice's offset
 * into `items`) and concatenates the results. A slice whose model reply was truncated
 * is split in half and each half retried; a single item that still truncates rethrows,
 * so the run fails loudly instead of degrading.
 * ponytail: slices run one after another; run them concurrently if synthesis wall time matters.
 */
export async function inBatches<I, R>(
  items: I[],
  size: number,
  run: (batch: I[], offset: number) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await splitOnTruncation(items.slice(i, i + size), i, run)));
  }
  return out;
}

async function splitOnTruncation<I, R>(
  batch: I[],
  offset: number,
  run: (batch: I[], offset: number) => Promise<R[]>,
): Promise<R[]> {
  try {
    return await run(batch, offset);
  } catch (err) {
    if (!(err instanceof OutputTruncatedError) || batch.length < 2) throw err;
    const mid = Math.ceil(batch.length / 2);
    return [
      ...(await splitOnTruncation(batch.slice(0, mid), offset, run)),
      ...(await splitOnTruncation(batch.slice(mid), offset + mid, run)),
    ];
  }
}
