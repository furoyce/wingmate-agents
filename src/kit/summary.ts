import { WingmateError } from "../shared/errors";
import { readNoFollow, worktreeFile } from "./local";

/** Match the former PR renderer's string limit (UTF-16 code units), without silently dropping text. */
export const FINISH_SUMMARY_MAX = 4000;
/** More than any UTF-8 encoding of an accepted summary; oversized files remain bounded reads. */
const SUMMARY_READ_BYTES = FINISH_SUMMARY_MAX * 4 + 1;

export async function readFinishSummary(wt: string, rel: string) {
  const file = await worktreeFile(wt, rel);
  if (!file.ok)
    throw new WingmateError("file_invalid", file.error, "write the summary to a file under .wingmate/ first");
  const bytes = await readNoFollow(file.abs, SUMMARY_READ_BYTES);
  const text = bytes.toString("utf8");
  if (text.length > FINISH_SUMMARY_MAX)
    throw new WingmateError(
      "summary_too_long",
      `finish summary is ${bytes.length === SUMMARY_READ_BYTES ? "at least " : ""}${text.length} characters; maximum is ${FINISH_SUMMARY_MAX}`,
      `shorten ${file.rel} to at most ${FINISH_SUMMARY_MAX} characters and retry finish; keep detailed evidence in .wingmate/evidence/`,
    );
  return { rel: file.rel, text };
}

/** An explicit shortened excerpt, never a partial word or a split Unicode character. */
export function summaryExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let prefix = text.slice(0, max - 1);
  if (!/\s/u.test(text[max - 1] ?? "") && !/\s$/u.test(prefix)) {
    const boundary = prefix.search(/\s+\S*$/u);
    prefix = boundary < 0 ? "" : prefix.slice(0, boundary);
  }
  return `${prefix.trimEnd()}…`;
}
