// Splits text into words that rise in one after another (.words in globals.css). The full text stays in the DOM.
import type { ReactNode } from "react";

export function Words({ children, delayMs = 0, start = 0 }: { children: string; delayMs?: number; start?: number }): ReactNode {
  const parts = children.split(/(\s+)/);
  let i = start;
  return (
    <span className="words" style={{ ["--d" as string]: `${delayMs}ms` }}>
      {parts.map((p, k) =>
        /^\s+$/.test(p) ? (
          p
        ) : (
          <span key={k} className="w" style={{ ["--i" as string]: i++ }}>
            {p}
          </span>
        ),
      )}
    </span>
  );
}
