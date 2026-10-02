// The Engram seal: a wax-seal mark used for "encrypted/sealed" states and the brand.
export function Seal({ size = 28, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path
        d="M16 1.8c1.6 0 2.3 1.5 3.8 1.9 1.5.4 2.9-.6 4.2.2 1.3.8 1.1 2.5 2.1 3.6 1 1.1 2.7 1.1 3.2 2.6.5 1.4-.6 2.7-.5 4.2.1 1.5 1.5 2.5 1.2 4-.3 1.5-2 1.8-2.7 3.1-.7 1.3-.1 3-1.2 4-1.1 1-2.7.4-4 1.1-1.3.7-1.6 2.4-3.1 2.7-1.5.3-2.5-1.1-4-1.2-1.5-.1-2.8 1-4.2.5-1.4-.5-1.5-2.2-2.6-3.2-1.1-1-2.8-.8-3.6-2.1-.8-1.3.2-2.7-.2-4.2-.4-1.5-1.9-2.2-1.9-3.8s1.5-2.3 1.9-3.8c.4-1.5-.6-2.9.2-4.2.8-1.3 2.5-1.1 3.6-2.1 1.1-1 1.1-2.7 2.6-3.2 1.4-.5 2.7.6 4.2.5 1.5-.1 2.5-1.5 4-1.2"
        fill="var(--color-seal)"
      />
      <circle cx="16" cy="16" r="8.6" fill="none" stroke="#f3eee4" strokeOpacity="0.55" strokeWidth="0.9" />
      <circle cx="16" cy="14.2" r="2.5" fill="#f3eee4" />
      <path d="M14.9 15.6h2.2l.9 5.2h-4z" fill="#f3eee4" />
    </svg>
  );
}
