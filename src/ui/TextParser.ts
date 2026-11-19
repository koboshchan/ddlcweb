export interface TextStyleState {
  italic: boolean;
  bold: boolean;
  color: string | null;
  size: number | null;
  font: string | null;
  cps: number | null;
}

export interface TextSpan {
  text: string;
  style: TextStyleState;
}

export interface ParsedDialogue {
  spans: TextSpan[];
  plainText: string;
  noWait: boolean;
}

/**
 * Parses Ren'Py inline text tags (`{i}`, `{b}`, `{color=...}`, `{size=...}`,
 * `{font=...}`, `{cps=...}`, `{nw}`, `{w}`, `{fast}`, `{space=...}`, `{{`, `}}`)
 * into styled spans for crisp typewriter rendering.
 */
export function parseRenpyText(raw: string): ParsedDialogue {
  const spans: TextSpan[] = [];
  const styleStack: TextStyleState[] = [
    {
      italic: false,
      bold: false,
      color: null,
      size: null,
      font: null,
      cps: null,
    },
  ];

  let noWait = false;
  let plain = "";
  let buffer = "";
  let i = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      spans.push({
        text: buffer,
        style: { ...styleStack[styleStack.length - 1] },
      });
      plain += buffer;
      buffer = "";
    }
  };

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{") {
      if (raw[i + 1] === "{") {
        buffer += "{";
        i += 2;
        continue;
      }

      const closeIdx = raw.indexOf("}", i + 1);
      if (closeIdx === -1) {
        buffer += ch;
        i += 1;
        continue;
      }

      const tag = raw.slice(i + 1, closeIdx).trim();
      i = closeIdx + 1;

      if (tag === "nw") {
        noWait = true;
        continue;
      }
      if (tag === "fast" || tag === "w" || tag.startsWith("w=") || tag === "done") {
        continue;
      }
      if (tag.startsWith("space=")) {
        buffer += " ";
        continue;
      }

      flush();

      const current = styleStack[styleStack.length - 1];
      if (tag.startsWith("/")) {
        if (styleStack.length > 1) {
          styleStack.pop();
        }
        continue;
      }

      const next: TextStyleState = { ...current };
      if (tag === "i") {
        next.italic = true;
        styleStack.push(next);
      } else if (tag === "b") {
        next.bold = true;
        styleStack.push(next);
      } else if (tag.startsWith("color=")) {
        next.color = tag.slice("color=".length);
        styleStack.push(next);
      } else if (tag.startsWith("size=")) {
        const val = parseInt(tag.slice("size=".length), 10);
        if (!Number.isNaN(val)) {
          next.size = val;
        }
        styleStack.push(next);
      } else if (tag.startsWith("font=")) {
        next.font = tag.slice("font=".length);
        styleStack.push(next);
      } else if (tag.startsWith("cps=")) {
        const val = parseFloat(tag.slice("cps=".length));
        if (!Number.isNaN(val)) {
          next.cps = val;
        }
        styleStack.push(next);
      }
      continue;
    }

    if (ch === "}" && raw[i + 1] === "}") {
      buffer += "}";
      i += 2;
      continue;
    }

    if (ch === "\\" && i + 1 < raw.length) {
      const nextCh = raw[i + 1];
      if (nextCh === "n") {
        buffer += "\n";
        i += 2;
        continue;
      }
      if (nextCh === '"' || nextCh === "'") {
        buffer += nextCh;
        i += 2;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();

  return {
    spans,
    plainText: plain,
    noWait,
  };
}
