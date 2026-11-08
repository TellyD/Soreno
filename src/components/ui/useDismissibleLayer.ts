import { useEffect, useRef } from "react";

type DismissibleLayer = {
  layerRef: { current: HTMLElement | null };
  onDismissRef: { current: () => void };
};

const layers: DismissibleLayer[] = [];

function topLayer() {
  return layers[layers.length - 1];
}

function handlePointerDown(event: PointerEvent) {
  const layer = topLayer();
  if (
    !event.defaultPrevented &&
    event.target instanceof Node &&
    !layer?.layerRef.current?.contains(event.target) &&
    // Notifications float above every layer; interacting with them must not close it.
    !(
      event.target instanceof Element &&
      event.target.closest("[data-notification-center]")
    )
  ) {
    layer?.onDismissRef.current();
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (!event.defaultPrevented && event.key === "Escape") {
    topLayer()?.onDismissRef.current();
  }
}

function registerLayer(layer: DismissibleLayer) {
  const element = layer.layerRef.current;
  const childIndex = layers.findIndex((candidate) => {
    const child = candidate.layerRef.current;
    return element !== null && child !== null && element.contains(child);
  });
  layers.splice(childIndex === -1 ? layers.length : childIndex, 0, layer);

  if (layers.length === 1) {
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
  }
}

function unregisterLayer(layer: DismissibleLayer) {
  const index = layers.indexOf(layer);
  if (index !== -1) {
    layers.splice(index, 1);
  }

  if (layers.length === 0) {
    document.removeEventListener("pointerdown", handlePointerDown);
    document.removeEventListener("keydown", handleKeyDown);
  }
}

export function useDismissibleLayer<T extends HTMLElement>(
  isOpen: boolean,
  onDismiss: () => void,
) {
  const layerRef = useRef<T>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const layer = { layerRef, onDismissRef };
    registerLayer(layer);
    return () => unregisterLayer(layer);
  }, [isOpen]);

  return layerRef;
}
