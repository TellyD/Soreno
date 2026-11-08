// Mouse wheels only emit deltaY; trackpad swipes and pinch-zoom (ctrlKey) keep their native behavior.
export function scrollWheelHorizontally(
  element: HTMLElement,
  event: WheelEvent,
) {
  const maxScroll = element.scrollWidth - element.clientWidth;
  if (
    event.ctrlKey ||
    maxScroll <= 0 ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  )
    return;
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? element.clientWidth
        : 1;
  event.preventDefault();
  element.scrollLeft = Math.max(
    0,
    Math.min(maxScroll, element.scrollLeft + event.deltaY * unit),
  );
}
