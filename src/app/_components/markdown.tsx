import { Fragment } from "react";
import { parseMarkdown, type Block, type Inline } from "refr/lib/markdown";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text": return <Fragment key={i}>{n.v}</Fragment>;
          case "br": return <br key={i} />;
          case "code": return <code key={i}>{n.v}</code>;
          case "b": return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case "i": return <em key={i}><Inlines nodes={n.c} /></em>;
          case "s": return <del key={i}><Inlines nodes={n.c} /></del>;
          case "a": return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer"><Inlines nodes={n.c} /></a>;
        }
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const H = (["h1", "h2", "h3"] as const)[b.level - 1]!;
            return <H key={i}><Inlines nodes={b.c} /></H>;
          }
          case "p": return <p key={i}><Inlines nodes={b.c} /></p>;
          case "ul": return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} /></li>)}</ul>;
          case "ol": return <ol key={i}>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} /></li>)}</ol>;
          case "quote": return <blockquote key={i}><Blocks blocks={b.c} /></blockquote>;
          case "pre": return <pre key={i}><code>{b.v}</code></pre>;
          case "hr": return <hr key={i} />;
        }
      })}
    </>
  );
}

/** Basic-markdown renderer (React elements only — no HTML injection). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`md ${className ?? ""}`}><Blocks blocks={parseMarkdown(text)} /></div>;
}
