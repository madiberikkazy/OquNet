import { iconSrc } from "../utils/icons.js";

/**
 * AppIcon — renders one of the icons in public/drawable by name.
 *
 * The icons are plain <img> rather than inline SVG so the artwork stays a
 * drop-in file: replacing /drawable/theme.svg replaces the icon everywhere,
 * colours included, without touching any component.
 */
export default function AppIcon({ name, size = 22, className = "", alt = "" }) {
  const src = iconSrc(name);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={"shrink-0 select-none " + className}
      draggable={false}
    />
  );
}
