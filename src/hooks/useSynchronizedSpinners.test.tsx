// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSynchronizedSpinners } from "./useSynchronizedSpinners";

function Harness() {
  useSynchronizedSpinners();
  return null;
}

it("aligns new and reappearing spinners without touching other animations, and cleans up", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const mount = document.createElement("div");
  host.append(mount);
  const root = createRoot(mount);
  const dispatch = (element: Element, animationName = "app-loading-spin") =>
    element.dispatchEvent(
      Object.assign(new Event("animationstart", { bubbles: true }), {
        animationName,
      }),
    );
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      ),
    );
    const animations = [];
    for (const startTime of [120, 640]) {
      const spinner = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      host.append(spinner);
      const spin = { animationName: "app-loading-spin", startTime };
      const unrelated = { animationName: "panel-reveal", startTime };
      const getAnimations = vi.fn(() => [spin, unrelated]);
      Object.defineProperty(spinner, "getAnimations", { value: getAnimations });
      dispatch(spinner, "panel-reveal");
      expect(getAnimations).not.toHaveBeenCalled();
      dispatch(spinner);
      expect(getAnimations).toHaveBeenCalledOnce();
      expect(spin.startTime).toBe(0);
      expect(unrelated.startTime).toBe(startTime);
      animations.push({ spinner, spin });
    }
    const { spinner, spin } = animations[1];
    spin.startTime = 1200; // CSS restarts the animation after display:none.
    dispatch(spinner);
    expect(spin.startTime).toBe(0);
    await act(async () => root.unmount());
    spin.startTime = 1500;
    dispatch(spinner);
    expect(spin.startTime).toBe(1500);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
