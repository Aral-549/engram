// The agent's mark: its initial set in the display serif inside an accent ring, like a signet.
export function Monogram({ letter, size = 44 }: { letter: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-full font-display text-[#f7f3ea] shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)]"
      style={{ width: size, height: size, background: "var(--color-seal)", fontSize: size * 0.56, lineHeight: 1 }}
    >
      <span style={{ transform: "translateY(-0.04em)" }}>{letter}</span>
    </span>
  );
}
