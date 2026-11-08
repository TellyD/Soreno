import { useLayoutEffect } from "react";

export function useSynchronizedSpinners() {
  useLayoutEffect(() => {
    function synchronize(event: AnimationEvent) {
      if (
        event.animationName !== "app-loading-spin" ||
        !(event.target instanceof Element)
      )
        return;
      for (const animation of event.target.getAnimations()) {
        if (
          "animationName" in animation &&
          animation.animationName === "app-loading-spin"
        ) {
          // Share the document timeline origin, including after a hidden spinner reappears.
          animation.startTime = 0;
        }
      }
    }
    document.addEventListener("animationstart", synchronize);
    return () => document.removeEventListener("animationstart", synchronize);
  }, []);
}
