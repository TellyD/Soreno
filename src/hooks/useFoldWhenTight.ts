import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether `folding` no longer fits beside `fixed` (and `reserve` px) in `container`, so it should fold
 * into a dropdown. Measured: labels vary by language and the buttons by request state.
 */
export function useFoldWhenTight(
  container: RefObject<HTMLElement | null>,
  folding: RefObject<HTMLElement | null>,
  fixed: RefObject<HTMLElement | null>[],
  reserve: number,
  mounted: boolean,
) {
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const box = container.current;
    const items = folding.current;
    const others = fixed.map((ref) => ref.current);
    if (
      !mounted ||
      !box ||
      !items ||
      others.some((element) => !element) ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const measure = () => {
      const style = getComputedStyle(box);
      const available =
        box.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap) || 0;
      const needed =
        items.offsetWidth +
        others.reduce((sum, element) => sum + gap + element!.offsetWidth, 0) +
        (reserve ? gap + reserve : 0);
      setFolded(needed > available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [box, items, ...others]) observer.observe(element!);
    return () => observer.disconnect();
    // The refs are stable; `mounted` re-attaches when the measured elements are replaced.
  }, [mounted, reserve]);
  return folded;
}
