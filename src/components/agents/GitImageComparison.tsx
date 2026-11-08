import { useState, type CSSProperties } from "react";
import { formatByteSize } from "../../domain/byteSize";
import type { GitContent } from "../../domain/projectGit";
import { useI18n } from "../../i18n";

type GitImageSide = {
  key: "before" | "after";
  label: string;
  content: GitContent;
  reason: string;
};

type Dimensions = { src: string; width: number; height: number };

function imageFormat(dataUrl: string): string | null {
  return /^data:image\/([\w.+-]+)[;,]/.exec(dataUrl)?.[1].toUpperCase() ?? null;
}

export default function GitImageComparison({
  sides,
  fileName,
}: {
  sides: GitImageSide[];
  fileName: string;
}) {
  const { locale } = useI18n();
  const [dimensions, setDimensions] = useState<
    Partial<Record<GitImageSide["key"], Dimensions>>
  >({});
  const measured = sides.map(({ key, content }) => {
    const size = dimensions[key];
    return size &&
      size.src === content.imageDataUrl &&
      size.width &&
      size.height
      ? size
      : null;
  });
  // Both sides share the bounding box of their images so a resize stays visible at a glance.
  const frame = measured.reduce<{ width: number; height: number } | null>(
    (box, size) =>
      size
        ? {
            width: Math.max(box?.width ?? 0, size.width),
            height: Math.max(box?.height ?? 0, size.height),
          }
        : box,
    null,
  );
  const sizeDelta =
    sides.length === 2 ? sides[1].content.size - sides[0].content.size : 0;

  return (
    <div className="git-image-comparison">
      {sides.map(({ key, label, content, reason }, index) => {
        const src = content.imageDataUrl;
        const size = measured[index];
        const format = src ? imageFormat(src) : null;
        return (
          <figure key={key} className="git-image-side">
            <figcaption>
              <strong>{label}</strong>
              <span className="git-image-meta">
                {size ? (
                  <span>
                    {size.width.toLocaleString(locale)} ×{" "}
                    {size.height.toLocaleString(locale)} px
                  </span>
                ) : null}
                <span
                  title={new Intl.NumberFormat(locale, {
                    style: "unit",
                    unit: "byte",
                    unitDisplay: "long",
                  }).format(content.size)}
                >
                  {formatByteSize(content.size, locale)}
                  {key === "after" && sizeDelta ? (
                    <span className="git-image-delta">
                      {" "}
                      ({formatByteSize(sizeDelta, locale, { signed: true })})
                    </span>
                  ) : null}
                </span>
                {format ? <span>{format}</span> : null}
              </span>
            </figcaption>
            <div className="git-image-stage">
              {src ? (
                <div
                  className={`git-image-frame${size && frame ? " is-measured" : ""}`}
                  style={
                    size && frame
                      ? ({
                          "--frame-width": `${frame.width}px`,
                          "--frame-aspect": frame.width / frame.height,
                        } as CSSProperties)
                      : undefined
                  }
                >
                  <img
                    src={src}
                    alt={`${label} — ${fileName}`}
                    style={
                      size && frame
                        ? {
                            width: `${(size.width / frame.width) * 100}%`,
                            height: `${(size.height / frame.height) * 100}%`,
                          }
                        : undefined
                    }
                    onLoad={({ currentTarget }) =>
                      setDimensions((current) => ({
                        ...current,
                        [key]: {
                          src,
                          width: currentTarget.naturalWidth,
                          height: currentTarget.naturalHeight,
                        },
                      }))
                    }
                  />
                </div>
              ) : (
                <p>{reason}</p>
              )}
            </div>
          </figure>
        );
      })}
    </div>
  );
}
