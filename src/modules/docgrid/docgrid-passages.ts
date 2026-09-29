import { PageRange } from "./docgrid-ocr";
export function passages(content: string, pages: PageRange[] = []) {
  const result: Array<{
    ordinal: number;
    start: number;
    end: number;
    page: number | null;
    text: string;
  }> = [];
  const ranges = pages.length
    ? pages
    : [{ start: 0, end: content.length, page: null }];
  for (const range of ranges) {
    for (let start = range.start; start < range.end;) {
      let end = Math.min(start + 2400, range.end);
      // Locators and JS strings use UTF-16; don't split a surrogate pair.
      if (end < range.end && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
      result.push({
        ordinal: result.length,
        start,
        end,
        page: range.page,
        text: content.slice(start, end),
      });
      if (end === range.end) break;
      start = end - 300;
      if (/[\uDC00-\uDFFF]/.test(content[start])) start++;
    }
  }
  return result;
}
