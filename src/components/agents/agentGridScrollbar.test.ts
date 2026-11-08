// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type {
  AgentGridFrame,
  AgentGridScroll,
} from "../../domain/agentSessions";
import { AgentGridScrollbar } from "./agentGridScrollbar";

let host: HTMLDivElement;
let scroll: Mock<(request: AgentGridScroll) => Promise<void>>;
let focus: Mock<() => void>;
let scrollbar: AgentGridScrollbar;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  scroll = vi.fn<(request: AgentGridScroll) => Promise<void>>(() =>
    Promise.resolve(),
  );
  focus = vi.fn<() => void>();
  scrollbar = new AgentGridScrollbar(host, { scroll, focus });
  scrollbar.setTrackHeight(200);
});
afterEach(() => {
  scrollbar.dispose();
  host.remove();
});

function frame(extra: Partial<AgentGridFrame>): AgentGridFrame {
  return {
    cols: 20,
    rows: 10,
    full: false,
    shift: 0,
    lines: [],
    cursor: { row: 0, col: 0, shape: "block" },
    displayOffset: 0,
    historySize: 30,
    selection: null,
    selectCount: 0,
    modes: 0,
    title: null,
    clipboard: null,
    state: "running",
    parsedBytes: 0,
    parseMicros: 0,
    ...extra,
  };
}

const track = () => host.querySelector<HTMLElement>(".agent-grid-scrollbar")!;
const thumb = () =>
  host.querySelector<HTMLElement>(".agent-grid-scrollbar-thumb")!;

function pointer(target: HTMLElement, type: string, clientY: number) {
  const event = new MouseEvent(type, {
    clientY,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
  return event;
}

it("sizes the thumb from the visible share and places it by display offset", () => {
  scrollbar.update(frame({ displayOffset: 0 }));
  expect(track().hidden).toBe(false);
  expect(thumb().style.height).toBe("50px");
  expect(thumb().style.transform).toBe("translateY(150px)");
  scrollbar.update(frame({ displayOffset: 15 }));
  expect(thumb().style.transform).toBe("translateY(75px)");
  scrollbar.update(frame({ displayOffset: 30 }));
  expect(thumb().style.transform).toBe("translateY(0px)");
  scrollbar.update(frame({ historySize: 9990, displayOffset: 0 }));
  expect(thumb().style.height).toBe("20px");
  expect(thumb().style.transform).toBe("translateY(180px)");
});

it("hides without history and on the alternate screen", () => {
  scrollbar.update(frame({ historySize: 0 }));
  expect(track().hidden).toBe(true);
  scrollbar.update(frame({ modes: 64 }));
  expect(track().hidden).toBe(true);
  scrollbar.update(frame({}));
  expect(track().hidden).toBe(false);
});

it("drags with one offset request in flight, sending only the latest position next", async () => {
  let finish!: () => void;
  scroll.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  scrollbar.update(frame({}));
  const hostDown = vi.fn();
  host.addEventListener("mousedown", hostDown);
  expect(pointer(thumb(), "pointerdown", 160).defaultPrevented).toBe(true);
  pointer(thumb(), "mousedown", 160);
  expect(hostDown).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  pointer(thumb(), "pointermove", 110);
  pointer(thumb(), "pointermove", 85);
  pointer(thumb(), "pointermove", 60);
  expect(scroll.mock.calls).toEqual([[{ kind: "offset", offset: 10 }]]);
  // The thumb follows the drag, not the stale frames still arriving.
  scrollbar.update(frame({ displayOffset: 0 }));
  expect(thumb().style.transform).toBe("translateY(50px)");
  finish();
  await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  expect(scroll).toHaveBeenLastCalledWith({ kind: "offset", offset: 20 });
  pointer(thumb(), "pointerup", 60);
  pointer(thumb(), "pointermove", 0);
  await Promise.resolve();
  expect(scroll).toHaveBeenCalledTimes(2);
});

it("pages when the track is clicked above or below the thumb", () => {
  scrollbar.update(frame({ displayOffset: 0 }));
  pointer(track(), "pointerdown", 40);
  expect(scroll).toHaveBeenLastCalledWith({ kind: "pageUp" });
  scrollbar.update(frame({ displayOffset: 30 }));
  pointer(track(), "pointerdown", 190);
  expect(scroll).toHaveBeenLastCalledWith({ kind: "pageDown" });
  expect(scroll).toHaveBeenCalledTimes(2);
});
