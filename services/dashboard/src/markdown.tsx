// A small Markdown subset for chat answers: headings, paragraphs, bullet and
// numbered lists, tables, fenced code, **bold**, *italic*, `code`, [links](…).
// It builds React elements (never innerHTML), so text from the model or from a
// tool result can't inject markup or scripts.
import type { ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[4]) {
      const label = tok.slice(1, tok.indexOf("]("));
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={k()}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Heading
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const kk = k();
      blocks.push(
        <p key={kk} className="md-h">
          {inline(h[2]!, kk)}
        </p>,
      );
      i++;
      continue;
    }
    // Table: header row, then a |---| separator
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      const kk = k();
      blocks.push(
        <div key={kk} className="table-wrap">
          <table className="table compact md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${kk}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${kk}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Lists
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(lines[i++]!.replace(re, ""));
      const kk = k();
      const children = items.map((it, j) => <li key={j}>{inline(it, `${kk}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={kk}>{children}</ol> : <ul key={kk}>{children}</ul>);
      continue;
    }
    // Paragraph: consecutive plain lines
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i]!)) {
      if (lines[i]!.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) break;
      para.push(lines[i++]!.replace(/\s{2,}$/, ""));
    }
    if (para.length === 0) {
      para.push(lines[i++]!); // safety: always advance
    }
    const kk = k();
    blocks.push(
      <p key={kk}>
        {para.flatMap((p, j) => (j ? [<br key={`${kk}br${j}`} />, ...inline(p, `${kk}-${j}`)] : inline(p, `${kk}-${j}`)))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
